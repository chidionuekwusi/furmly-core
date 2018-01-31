const constants = require("./constants"),
	systemEntities = constants.systemEntities,
	async = require("async"),
	misc = require("./misc"),
	fs = require("fs"),
	vm = require("vm"),
	_ = require("lodash"),
	debug = require("debug")("entity-repo"),
	path = require("path"),
	generator = require("mongoose-gen"),
	ObjectID = require("mongodb").ObjectID,
	DynamoProcess = require("./process"),
	DynamoStep = require("./step"),
	DynamoProcessor = require("./processor"),
	DynamoElement = require("./element"),
	DynamoForm = require("./form"),
	DynamoLib = require("./lib"),
	DynamoAsyncValidator = require("./async-validator"),
	mongoose = require("mongoose");

mongoose.Promise = global.Promise;
/**
 * @typedef {ProcessorContext}
 * @property {module:Dynamo.EntityRepo#queryEntity} get retrieves entities
 * @property {string} name The name
 * @property {module:Dynamo.EntityRepo#countEntity} count Counts entities that match the criteria
 */

/**
	 * Proxy function used to restrict access to system entities.
	 * @return {Function} Constructed proxy function.
	 */
function blockSystemEntities() {
	let args = Array.prototype.slice.call(arguments);
	if (this._systemEntities.indexOf(args[1]) !== -1)
		return args[args.length - 1](
			new Error(`Access Violation '${args[1]}' ${args[0]}`)
		);

	return args[0].apply(this, args.slice(1));
}

/**
	 * This class contains the persistence logic for all entities.
	 * @class
	 * 
	 * @memberOf module:Dynamo
	 * @param {Object} opts Class constructor parameters , includes ext,folder,delimiter,store...etc
	 */
function EntityRepo(opts) {
	var self = this;
	opts = opts || {};
	this.models = {};
	this.schemas = {};
	this.validators = {};
	this.transformers = {};
	this.refs = {};
	this._changeDetection = {};
	this.entityExt = opts.ext || ".json";
	this.entityFolder = opts.folder || "./src/entities/";
	this.delimiter = opts.delimiter || /('|")\$\{(\w+)\}+('|")/i;
	this._systemEntities = _.map(systemEntities, function(x) {
		return x;
	});
	this.store =
		opts.store ||
		function() {
			var collection = mongoose.connection.db.collection("_temp_store_");

			function createIndex(fn) {
				collection.createIndex(
					{
						createdOn: 1
					},
					{
						expireAfterSeconds: opts.storeTTL || 60
					},
					fn
				);
			}
			return {
				get: function(id, fn) {
					collection.findOne(
						{
							_id: id ? ObjectID(id) : id
						},
						fn
					);
				},
				update: function(id, info, extra, fn) {
					if (Array.prototype.slice.call(arguments).length == 3) {
						fn = extra;
						extra = null;
					}
					collection.update(
						{
							_id: id ? ObjectID(id) : id
						},
						{
							value: info,
							extra: extra,
							createdOn: new Date()
						},
						fn
					);
				},
				remove: function(id, fn) {
					collection.deleteOne(
						{
							_id: id ? ObjectID(id) : id
						},
						fn
					);
				},
				keep: function(info, extra, fn) {
					if (Array.prototype.slice.call(arguments).length == 2) {
						fn = extra;
						extra = null;
					}
					createIndex(function() {
						collection.insertOne(
							{
								value: info,
								extra: extra,
								createdOn: new Date()
							},
							fn
						);
					});
				}
			};
		};
	this.config = opts.config;
	const isIDOnly = function(item) {
			return (
				typeof item == "string" ||
				item instanceof ObjectID ||
				(item && Object.keys(item).length == 1 && item._id)
			);
		},
		getIDOnly = function(item) {
			return (
				((typeof item == "string" || item instanceof ObjectID) &&
					item) ||
				item._id
			);
		};
	/**
	 * @type {module:Dynamo~ProcessorContext}
	 * @property {module:Dynamo.EntityRepo#queryEntity} get function for querying objects
	 */
	this.processorEntityRepo = {
		get: blockSystemEntities.bind(self, self.queryEntity),
		count: self.countEntity.bind(this),
		update: blockSystemEntities.bind(self, self.updateEntity),
		delete: blockSystemEntities.bind(self, self.deleteEntity),
		create: blockSystemEntities.bind(self, self.createEntity),
		createSchema: self.createConfig.bind(self),
		updateSchema: self.updateConfig.bind(self),
		getSchema: self.getConfig.bind(self),
		getSchemas: self.getConfigNames.bind(self),
		createId: self.createId.bind(null),
		infrastructure: function() {
			return self.infrastructure;
		},
		store: self.store,
		aggregate: blockSystemEntities.bind(self, self.aggregateEntity),
		getCollectionName: blockSystemEntities.bind(
			self,
			self.getCollectionName
		)
	};

	this.transformers[systemEntities.process] = function(item, fn) {
		if (!(item instanceof DynamoProcess)) {
			var tasks = [];
			if (typeof item == "string" || item instanceof ObjectID) {
				tasks.push(
					self.queryEntity.bind(
						self,
						systemEntities.process,
						{
							_id: item
						},
						{
							full: true,
							one: true
						}
					)
				);
			} else {
				tasks.push(function(callback) {
					if (!item.steps) {
						return callback(
							new Error("Process must include atleast one step")
						);
					}
					if (!item.save)
						item.save = self.getSaveService(systemEntities.process);
					if (item.steps.length > 1) {
						item.store = self.store;
					}
					if (item.fetchProcessor) {
						item.entityRepo = self.processorEntityRepo;
					}
					var itasks = [];
					item.steps.forEach(function(step) {
						itasks.push(
							self.transformers[systemEntities.step].bind(
								self,
								step
							)
						);
					});
					async.parallel(itasks, function(er, steps) {
						if (er) return callback(er);

						item.steps = steps;
						let _process;
						if (item.fetchProcessor) {
							self.transformers[
								systemEntities.processor
							](item.fetchProcessor, function(er, fp) {
								if (er) return callback(er);
								item.fetchProcessor = fp;
								try {
									_process = new DynamoProcess(item);
								} catch (e) {
									return callback(e);
								}
								callback(null, _process);
							});
							return;
						}
						try {
							_process = new DynamoProcess(item);
						} catch (e) {
							return callback(e);
						}
						callback(null, _process);
					});
				});
			}
			return async.waterfall(tasks, fn);
		}
		return fn(null, item);
	};

	this.transformers[systemEntities.step] = function(item, fn) {
		if (!(item instanceof DynamoStep)) {
			var tasks = [],
				processorTasks = [],
				postprocessorTasks = [];
			if (isIDOnly(item)) {
				self.queryEntity(
					systemEntities.step,
					{
						_id: getIDOnly(item)
					},
					{
						full: true,
						one: true
					},
					fn
				);
			} else {
				if (!item.save)
					item.save = self.getSaveService(systemEntities.step);

				if (item.stepType == constants.STEPTYPE.CLIENT) {
					item.entityRepo = self.processorEntityRepo;
					tasks.push(function(callback) {
						self.transformers.form(item.form, function(er, form) {
							if (er) return callback(er);
							item.form = form;
							return callback();
						});
					});
				}
				if (item.postprocessors) {
					item.postprocessors.forEach(function(proc) {
						postprocessorTasks.push(
							self.transformers[systemEntities.processor].bind(
								self,
								proc
							)
						);
					});
					tasks.push(function(callback) {
						async.parallel(postprocessorTasks, function(
							er,
							postprocessors
						) {
							if (er) return callback(er);
							item.postprocessors = postprocessors;
							callback();
						});
					});
				}
				(item.processors || []).forEach(function(proc) {
					processorTasks.push(
						self.transformers[systemEntities.processor].bind(
							self,
							proc
						)
					);
				});
				if (processorTasks.length)
					tasks.push(function(callback) {
						async.parallel(processorTasks, function(
							er,
							processors
						) {
							if (er) return callback(er);
							item.processors = processors;
							callback();
						});
					});

				async.parallel(tasks, function(er) {
					if (er) return fn(er);
					let _step;
					try {
						_step = new DynamoStep(
							Object.assign(item, { config: self.config })
						);
					} catch (e) {
						return fn(e);
					}
					return fn(null, _step);
				});
			}
			return;
		}
		return fn(null, item);
	};
	this.transformers[systemEntities.asyncValidator] = function(item, fn) {
		basicTransformer(
			item,
			DynamoAsyncValidator,
			systemEntities.asyncValidator,
			fn
		);
	};
	this.transformers[systemEntities.processor] = function(item, fn) {
		basicTransformer(item, DynamoProcessor, systemEntities.processor, fn);
	};

	this.transformers[systemEntities.element] = function(item, fn) {
		if (!(item instanceof DynamoElement)) {
			//this shouldnt happen now , elements are part of steps.
			if (isIDOnly(item)) {
				return self.queryEntity(
					systemEntities.element,
					{
						_id: getIDOnly(item)
					},
					{
						full: true,
						one: true
					},
					fn
				);
			}

			if (!item.save)
				item.save = self.getSaveService(systemEntities.element);

			async.parallel(
				_.map(item.asyncValidators, function(x) {
					return self.transformers[
						systemEntities.asyncValidator
					].bind(self, x);
				}),
				function(er, asyncValidators) {
					if (er) return fn(er);
					item.asyncValidators = asyncValidators;
					let _element;
					try {
						_element = new DynamoElement(item);
					} catch (e) {
						return fn(e);
					}
					return fn(null, _element);
				}
			);
			return;
		}
		return fn(null, item);
	};
	this.transformers.form = function(item, fn) {
		if (!(item instanceof DynamoForm)) {
			if (!item)
				return (
					debug("step does not have a form"),
					fn(new Error("Step requires a form"))
				);
			async.parallel(
				_.map(item.elements, function(element) {
					return self.transformers[systemEntities.element].bind(
						self.transformers,
						element
					);
				}),
				function(er, elements) {
					if (er) return fn(er);
					item.elements = elements;
					let _form;
					try {
						_form = new DynamoForm(item);
					} catch (e) {
						return fn(e);
					}
					return fn(null, _form);
				}
			);
			return;
		}
		return fn(null, item);
	};
	this.transformers[systemEntities.lib] = function(item, fn) {
		basicTransformer(item, DynamoLib, systemEntities.lib, fn);
	};

	function basicTransformer(item, clazz, entName, fn) {
		if (!(item instanceof clazz)) {
			if (isIDOnly(item)) {
				//
				return self.queryEntity(
					entName,
					{
						_id: getIDOnly(item)
					},
					{
						full: true,
						one: true
					},
					fn
				);
			}

			if (!item.save) item.save = self.getSaveService(entName);

			let i = new clazz(item);
			return fn(null, i);
		}

		return fn(null, item);
	}
}

/**
 * This function sets the infrastructure (services provided by Server etc.)
 * @param {Object} manager infrastructure
 */
EntityRepo.prototype.setInfrastructure = function(manager) {
	this.infrastructure = manager;
};

/**
 * Function used to initialize components
 * @param  {Function} callback Callback called when initialization is completed
 * @return {Void}            No return type
 */
EntityRepo.prototype.init = function(callback) {
	generator.setDefault("requiresIdentity", function(value) {
		return true;
	});
	const _init = () => {
		if (typeof this.store == "function") {
			this.store = this.store();
		}

		var self = this;
		let element =
			'{"component_uid":{"type":"String"}, "order":{"type":"Number"}, "uid":{"type":"String"},"name":{"type":"String","required":true},"label":{"type":"String"},"description":{"type":"String"},"elementType":{"type":"String","enum":[' +
			_.map(Object.keys(constants.ELEMENTTYPE), function(x) {
				return '"' + x + '"';
			}).join(",") +
			'],"required":true},"asyncValidators":[{"type":"ObjectId","ref":"' +
			systemEntities.asyncValidator +
			'"}],"validators":[{"validatorType":{"type":"String","enum":[' +
			_.map(Object.keys(constants.VALIDATORTYPE), function(x) {
				return '"' + x + '"';
			}).join(",") +
			'],"required":true},"args":{"type":"Mixed"}}],"args":{"type":"Mixed"}}';

		async.parallel(
			[
				fs.writeFile.bind(
					this,
					self.getPath(systemEntities.process),
					'{"requiresIdentity":{"type":"Boolean","default":"requiresIdentity"},"fetchProcessor":{"type":"ObjectId","ref":"' +
						systemEntities.processor +
						'"},"uid":{"type":"String","unique":true,"sparse":true},"title":{"type":"String","required":true},"description":{"type":"String","required":true},"steps":[{"type":"ObjectId","ref":"' +
						systemEntities.step +
						'"}]}'
				),
				fs.writeFile.bind(
					this,
					self.getPath(systemEntities.step),
					'{"description":{"type":"String"},"mode":{"type":"String"},"processors":[{"type":"ObjectId","ref":"' +
						systemEntities.processor +
						'"}],"postprocessors":[{"type":"ObjectId","ref":"' +
						systemEntities.processor +
						'"}],"stepType":{"type":"String","required":true},"form":{"elements":[' +
						element +
						"]}}"
				),
				fs.writeFile.bind(
					this,
					self.getPath(systemEntities.processor),
					'{"requiresIdentity":{"type":"Boolean","default":"requiresIdentity"},"uid":{"type":"String","unique":true,"sparse":true},"code":{"type":"String","required":true},"title":{"type":"String", "required":true}}'
				),
				fs.writeFile.bind(
					this,
					self.getPath(systemEntities.lib),
					'{"uid":{"type":"String","unique":true,"required":true},"code":{"type":"String","required":true}}'
				),
				fs.writeFile.bind(
					this,
					self.getPath(systemEntities.asyncValidator),
					'{"requiresIdentity":{"type":"Boolean","default":"requiresIdentity"},"uid":{"type":"String","unique":true,"sparse":true},"code":{"type":"String","required":true},"title":{"type":"String", "required":true}}'
				)
			],
			function(er) {
				if (er) return callback(er);
				self.createSchemas(callback);
			}
		);
	};
	mongoose
		.connect(this.config.data.dynamo_url)
		.then(_init)
		.catch(e => {
			if (e && e.message !== "Trying to open unclosed connection.")
				return callback();

			return _init(e);
		});
};

//service injected into domain objects for persistence.
/**
 * Service used by entities to save themselves.
 * @param  {String} entName Entity Name
 * @return {Function}  Object representing save service.     
 */
EntityRepo.prototype.getSaveService = function(entName) {
	var self = this;
	/**
	 * Save serice function tailored to entName		
	 * @param  {Object}   info 
	 * @param  {Function} fn   Callback
	 *
	 */
	return function(info, fn) {
		function transformResult(er, result) {
			if (er) return fn(er);
			if (!result._id) console.log(arguments);
			fn(null, {
				_id: result._id
			});
		}

		if (!info._id) {
			self.createEntity(entName, info, transformResult);
		} else self.updateEntity(entName, info, transformResult);
	};
};

/**
 * Creates an Entity Schema.
 * @param  {some}   name   Config Name
 * @param  {Object}   config Object schema
 * @param  {Function} fn     Callback
 * 
 */
EntityRepo.prototype.createConfig = function(name, config, fn) {
	if (this._systemEntities.indexOf(this.name) !== -1)
		throw new Error("Cannot Create Entity with that name.");
	var self = this;

	fs.writeFile(this.getPath(name), JSON.stringify(config), "utf8", function(
		er
	) {
		if (er) return fn(er);
		self.createSchemas(fn);
	});
};

EntityRepo.prototype.getPath = function(name) {
	return this.entityFolder + name + this.entityExt;
};
/**
 * Get Schema Configuration
 * @param  {String}   name Name of Collection/Table
 * @param  {Function} fn   Callback
 * 
 */
EntityRepo.prototype.getConfig = function(name, fn) {
	if (!name) return fn(new Error("name must be defined"));
	fs.readFile(
		this.getPath(name),
		{
			encoding: "utf8"
		},
		function(er, data) {
			try {
				data = JSON.parse(data);
			} catch (e) {
				return fn(new Error("Failed to parse config file"));
			}
			fn(er, data);
		}
	);
};
/**
 * Get Schema Configuration Names
 * @param  {Function} fn Callback
 * 
 */
EntityRepo.prototype.getConfigNames = function(fn) {
	fn(
		null,
		Object.keys(this.models).filter(
			function(x) {
				return this._systemEntities.indexOf(x) == -1;
			}.bind(this)
		)
	);
};
EntityRepo.prototype.isValidID = function(id) {
	return mongoose.Types.ObjectId.isValid(id);
};
EntityRepo.prototype.getAllConfiguration = function(fn) {
	var self = this;
	getDirectories(this.entityFolder, function(er, ents) {
		var tasks = [];
		ents.forEach(function(file) {
			if (file.indexOf(self.del) === -1) {
				tasks.push(
					self.getConfig.bind(
						self,
						path.basename(file, path.extname(file))
					)
				);
			}
		});
		async.parallel(tasks, fn);
	});
};

EntityRepo.prototype.createId = function(string) {
	return ObjectID(string);
};
EntityRepo.prototype.updateConfig = function(name, config, fn) {
	if (!name) return fn(new Error("name must be defined"));
	if (this._systemEntities.indexOf(this.name) !== -1)
		throw new Error("Cannot Update Entity with that name.");
	var self = this;

	fs.truncate(this.getPath(name), function() {
		self.createConfig(name, config, fn);
	});
};

/**
 * Find entity  of type {name} using {filter}
 * @param  {String}   name    Name of Collection/Table
 * @param  {Object}   filter  Query filter
 * @param  {Object}   options sorting,populating extra values etc [optional]
 * @param  {Function} fn      Callback
 * 
 */
EntityRepo.prototype.queryEntity = function(name, filter, options, fn) {
	var self = this,
		circularDepth =
			options && options.circularDepth ? options.circularDepth : 1,
		referenceCount = {},
		keys;
	if (Array.prototype.slice.call(arguments).length == 3) {
		fn = options;
		options = null;
	}

	function populate(arr, result, parent) {
		arr.forEach(function(item) {
			if (parent && new RegExp(item.path + "$").test(parent)) {
				referenceCount[item.model] = referenceCount[item.model]
					? referenceCount[item.model] + 1
					: 1;
			}

			result.push((parent ? parent + "." : "") + item.path);
			if (
				self.refs[item.model] &&
				(referenceCount[item.model] || 0) < circularDepth
			) {
				populate(
					self.refs[item.model],
					result,
					result[result.length - 1]
				);
			}
		});
		return result;
	}

	function transformResult(er, result) {
		if (er) return fn(er);
		if (self.transformers[name] && (!options || !options.noTransformaton)) {
			async.parallel(
				_.map(result, function(x) {
					return self.transformers[name].bind(self.transformers, x);
				}),
				function(er, transformed) {
					if (!fn) {
						debugger;
						debug("no callback");
					}
					if (er) return fn(er);
					if (options && options.one && transformed)
						transformed = transformed.length
							? transformed[0]
							: null;

					fn(null, transformed);
				}
			);
			return;
		}
		if (!fn) {
			debugger;
			debug("no callback");
		}
		fn(
			null,
			options && options.one ? (result.length ? result[0] : null) : result
		);
	}

	if (!this.models[name]) {
		return setImmediate(fn, new Error("Model does not exist"));
	}
	var query = this.models[name].find(filter);
	if (
		options &&
		options.full &&
		this.refs[name] &&
		this.refs[name].length !== 0
	) {
		debug(`entity being queried : ${name}`);
		//debug(self.refs[name]);
		var populateString = populate(self.refs[name], []);
		populateString.forEach(function(string) {
			if ((string.match(/\./gi) || []).length >= 1) {
				var cur = "",
					temp = "",
					m = {},
					iterator = function(x, index, arr) {
						cur += x;
						temp += x;
						if (index < arr.length - 1) {
							if (populateString.indexOf(temp) !== -1) cur += "|";
							else {
								cur += ".";
							}
							temp += ".";
						}
					},
					reducer = function(sum, c) {
						if (!sum.path) {
							sum.path = c;
							return sum;
						}
						sum.populate = {
							path: c
						};
						return sum.populate;
					};
				string.split(".").forEach(iterator);
				_.reduce(cur.split("|"), reducer, m);
				//debug(m);
				query.populate(m);
				return;
			}
			//debug(string);
			query.populate(string);
		});
	}
	if (options) {
		if (options.sort) {
			query = query.sort(options.sort);
		}
		if (options.limit) {
			query.limit(options.limit);
		}
		if (options.fields) {
			query.select(options.fields);
		}
	}

	query.lean().exec(transformResult);
};
/**
 * Update an entity
 * @param  {String}   name Name of the collection/table entity is located in
 * @param  {Object}   data Update data
 * @param  {Function} fn   Callback
 * 
 */
EntityRepo.prototype.updateEntity = function(name, data, fn) {
	var self = this;
	if (!this.models[name]) {
		return setImmediate(fn, new Error("Model does not exist"));
	}
	if (this._changeDetection[name]) {
		this.models[name].findOne(
			{
				_id: data._id
			},
			function(er, e) {
				if (er) return fn(er);
				if (!e) return fn(new Error("that entity does not exist"));
				var merged = _.assign(e, data);
				debug(merged);
				self._changeDetection[name].forEach(function(field) {
					merged.set(field, data[field]);
				});
				merged.save(fn);
			}
		);
	} else {
		this.models[name].update(
			{
				_id: data._id
			},
			data,
			function(er, stat) {
				if (er) return fn(er);
				if (stat <= 0)
					return fn(new Error("that entity does not exist"));
				fn(null, {
					_id: data._id
				});
			}
		);
	}
};

/**
 * Create an entity
 * @param  {String}   name Name of the collection/table entity is located in
 * @param  {Object}   data Update data
 * @param  {function} fn   Callback
 * 
 */
EntityRepo.prototype.createEntity = function(name, data, fn) {
	if (!this.models[name]) {
		return setImmediate(fn, new Error("Model does not exist"));
	}
	var item = new this.models[name](data);
	item.save(fn);
};
/**
 * Function that runs aggregation query on persistance object.
 * @param  {String}    name Name of collection/table to run aggregation on
 * @param  {...Object} rest Other Args including aggregation query and callback
 * 
 */
EntityRepo.prototype.aggregateEntity = function(name, ...rest) {
	let model = this.models[name];
	misc.runThroughObj(
		[
			(key, data, result, parent, parentKey, index) => {
				if (key == "$objectID") {
					let id = ObjectID(data[key]);
					if (!index) parent[parentKey] = id;
					else parent[parentKey][index] = id;
				}
			}
		],
		rest[0]
	);
	debug(JSON.stringify(rest[0], null, " "));
	return model.aggregate.apply(model, rest);
};
/**
 * Count number of entities that match the filter supplied
 * @param  {String}   name   Name of Collection/Table
 * @param  {Object}   filter Query
 * @param  {Function} fn     Callback
 * 
 */
EntityRepo.prototype.countEntity = function(name, filter, fn) {
	if (!this.models[name]) {
		return setImmediate(fn, new Error("Model does not exist"));
	}
	debug(`filter:${JSON.stringify(filter, null, " ")}`);
	this.models[name].count(filter, fn);
};
/**
 * Normalizes mongoose collection names to actual mongodb  collection names
 * @param  {String} name Name of Collection/Table
 * @return {String}      Correct collection name.
 */
EntityRepo.prototype.getCollectionName = function(name) {
	return (this.models[name] && this.models[name].collection.name) || null;
};
/**
 * Delete an entity with the supplied id
 * @param  {String}   name Name of Collection/Table
 * @param  {String}   id   Id of object to delete
 * @param  {Function} fn   Callback
 * 
 */
EntityRepo.prototype.deleteEntity = function(name, id, fn) {
	if (!this.models[name]) {
		return setImmediate(fn, new Error("Model does not exist"));
	}
	let query = { _id: id };
	if (Array.prototype.isPrototypeOf(id)) {
		query = { _id: { $in: id } };
	}
	if (!Array.prototype.isPrototypeOf(id) && typeof id == "object") {
		if (!Object.keys(id).length)
			return setImmediate(fn, new Error(`That would delete all ${name}`));
		query = id;
	}

	this.models[name].remove(query, fn);
};
EntityRepo.prototype.createSchemas = function(fn) {
	var self = this;

	function createRunContext(code) {
		return function(value) {
			var sandbox = {
				value: value
			};
			var script = new vm.Script(code);
			var context = new vm.createContext(sandbox);
			script.runInNewContext(context);
			return !!sandbox.result;
		};
	}

	function assignModel(callback) {
		var that = this;
		try {
			var existing = self.models[this.prop] || mongoose.model(this.prop);
			var newSchema = JSON.parse(this.item);
			var diff = _.omitBy(newSchema, function(v, k) {
				return _.isEqual(self.schemas[that.prop][k], v);
			});

			var indexes = removeCompoundIndexes(diff);
			var change = Object.keys(diff);
			if (diff && change.length) {
				existing.schema.add(generator.convert(diff));
				removeCompoundIndexes(newSchema);
				self.models[this.prop] = existing;
				self.schemas[this.prop] = newSchema;
				self._changeDetection[this.prop] = change;
				self.refs[that.prop] = getRefs(newSchema);
			}
			debug(indexes);
			if (indexes.length)
				setupCompoundIndexes(self.models[this.prop].schema, indexes);
		} catch (e) {
			if (e.name == "MissingSchemaError") {
				var _schema = JSON.parse(that.item);
				var indexes = removeCompoundIndexes(_schema);
				self.schemas[that.prop] = _schema;
				self.refs[that.prop] = getRefs(self.schemas[that.prop]);
				var schema = new mongoose.Schema(
					generator.convert(self.schemas[that.prop]),
					{ autoIndex: false }
				);
				self.models[that.prop] = mongoose.model(that.prop, schema);
				if (indexes.length) {
					setupCompoundIndexes(schema, indexes);
				}
			} else return callback(e);
		}

		callback();
	}
	function setupCompoundIndexes(schema, indexes) {
		indexes.forEach(x => {
			schema.index(
				x.reduce((s, v) => {
					return (s[v] = 1), s;
				}, {}),
				{ unique: true, sparse: true }
			);
		});
	}
	function removeCompoundIndexes(schema) {
		let indexes = [];
		if (schema.compound_index) {
			indexes = schema.compound_index;
			delete schema.compound_index;
		}
		return indexes;
	}
	function getRefs(file, key) {
		var props = Object.keys(file),
			refs = [];
		if (!key) key = "";
		props.forEach(function(prop) {
			if (prop == "ref" || prop == "refPath") {
				refs.push({
					model: file.ref,
					path: key.substring(0, key.length - 1)
				});
				return;
			}

			if (typeof file[prop] == "object") {
				var obj = file[prop];
				if (obj instanceof Array) {
					if (typeof obj[0] == "object") obj = obj[0];
					else return;
				}
				refs = refs.concat(getRefs(obj, key + prop + "."));
				return;
			}
		});

		return refs;
	}

	function registerValidator(result, callback) {
		var that = this;
		self.getValidator(this.name, function(er, v) {
			if (er) return callback(er);
			if (!self.validators[that.name])
				generator.setValidator(
					that.name,
					(self.validators[that.name] = createRunContext(v.code))
				);

			return callback();
		});
	}

	function throwError(er) {
		throw new Error(er);
	}

	function parseEntities(files, fn) {
		var tasks = [
			function(callback) {
				return callback(null);
			}
		];

		for (var prop in files) {
			if (files.hasOwnProperty(prop)) {
				var item = parse(files[prop], files);

				var validate_exp = /"validate"\\s*\:\\s*"(\w+)"/gi;
				var match = validate_exp.exec(item);
				while (match) {
					tasks.push(
						registerValidator.bind({
							name: match[1]
						})
					);
					match = validate_exp.exec(item);
				}

				// Generate the Schema object.
				tasks.push(
					assignModel.bind({
						item: item,
						prop: prop
					})
				);

				self[prop] = item;
				//this more or less caches the expansion
				files[prop] = item;
			}
		}
		async.waterfall(tasks, function(er, result) {
			debug(self.refs);
			fn(er);
		});
	}

	function parse(file, allFiles) {
		var del = self.delimiter;
		var result = file;
		var match = del.exec(file);
		while (match) {
			result.replace(match[0], parse(allFiles[match[2]]));
			match = del.exec(file);
		}
		return result;
	}
	async.waterfall(
		[
			function(callback) {
				misc.getDirectories(self.entityFolder, function(er, response) {
					if (er) {
						return callback(er);
					}
					var allFiles = {};

					response.forEach(function(filePath) {
						var data = fs.readFileSync(filePath, {
							encoding: "utf8"
						});
						allFiles[path.basename(filePath, ".json")] = data;
					});
					callback(null, allFiles);
				});
			},
			parseEntities
		],
		fn || function() {}
	);
};

module.exports = EntityRepo;
