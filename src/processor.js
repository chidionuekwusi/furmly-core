/**
 * Class Constuctor for a FurmlyProcessor
 * @constructor
 * @memberOf module:Furmly
 * @param {Any} opts Constructor arguments
 */
function FurmlyProcessor(opts) {
  this.debug = require("debug")("processor-constructor");
  this.assert = require("assert");
  if (!opts.code) {
    this.debug(opts);
    throw new Error("Processor must include code to run.");
  }

  if (!opts.title) {
    this.debug(opts);
    throw new Error("Processor must have a title");
  }

  if (!opts.save) {
    this.debug(opts);
    throw new Error("Processor needs save service for persistence");
  }

  var self = this;
  this._id = opts._id;
  this.code = opts.code;
  this.title = opts.title;
  this.uid = opts.uid;
  this.requiresIdentity = opts.requiresIdentity;
  this.standalone = opts.standalone;
  this._code = opts._code;
  this._references = opts._references;

  Object.defineProperties(this, {
    _save: {
      enumerable: false,
      get: function() {
        return opts.save;
      }
    },
    getCode: {
      enumerable: false,
      value: function() {
        return this._code || this.code;
      }
    },
    codeGenerator: { enumerable: false, value: opts.codeGenerator }
  });

  /**
   *  User customisable code ran in sandbox.
   * @param  {Any}   result  passed in result for previous processor.
   * @param  {Function} callback callback function.
   * @return {Any}            result of process.
   */

  this.process = function(result, callback) {
    if (typeof result == "function") {
      callback = result;
      result = null;
    }
    self.assert.strictEqual(
      typeof callback === "function",
      true,
      "Processor callback must be a function"
    );
    const _callback = callback;
    let callCount = 0;
    callback = (...args) => {
      if (callCount) {
        this.debug(
          `Processor "${self.title}" id:${
            self._id
          } is attempting to return twice`
        );
        return;
      }
      try {
        callCount += 1;
        _callback.apply(null, args);
      } catch (e) {
        this.debug("an error occurred in callback function");
        this.debug(e);
      }
    };
    try {
      let code = self.getCode();
      self.validate();
      /* jshint ignore:start */
      if (this.SANDBOX_CONTEXT) {
        //added extra check to ensure this code never runs in engine context.
        this.debug(`running processor '${self.title}' ${self._id} `);

        eval(code);
      }

      /* jshint ignore:end */
    } catch (e) {
      // statements
      this.debug("error caught by processor , description: \n" + e.message);
      callback(e);
    }
  };
}

/**
 * Class invariant function
 * @return {Void} nothing
 */
FurmlyProcessor.prototype.validate = function() {
  if (!this._id) throw new Error("Processor requires a valid _id");
};

/**
 * Creates a description of the processor a client can consume
 * @param  {Function} fn callback
 * @return {Object}      object representing the processor.
 */
FurmlyProcessor.prototype.describe = function(fn) {
  fn(null, {
    title: this.title,
    _id: this._id
  });
};

/**
 * Persists this object using passed in persistence service
 * @param  {Function} fn calllback
 * @return {Any}      saved object
 */
FurmlyProcessor.prototype.save = function(fn) {
  var model = {
    _id: this._id,
    code: this.code,
    title: this.title,
    requiresIdentity: this.requiresIdentity,
    standalone: this.standalone
  };
  if (this.uid) {
    model.uid = this.uid;
  }
  if (this.codeGenerator) {
    let { code, references = {} } = this.codeGenerator.optimize(model.code);
    this.assert.strictEqual(
      true,
      typeof code === "string",
      "Optimized Code must be a string"
    );
    model._code = code;
    model._references = Object.keys(references);
  }
  this._save(model, fn);
};

module.exports = FurmlyProcessor;
