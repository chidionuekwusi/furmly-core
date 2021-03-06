const FurmlyElement = require("../element"),
  misc = require("../element-utils"),
  _ = require("lodash"),
  async = require("async"),
  _warn = misc.warn(require("debug")("element:selectset"));
elementInvariants = misc.elementInvariants;

class Selectset extends FurmlyElement {
  constructor(opts, factory) {
    super(opts);
    //add invariants here.
    this.invariants();
    if (this.args.items) {
      this.args.items.forEach(x => {
        misc.convert(factory, x, "elements", super.getServices());
      });
    }
    this.dynamicFields.push("args.items.displayLabel");
    this.factory = factory;
  }
  describe(fn) {
    super.describe((er, description) => {
      if (er) return fn(er);
      let tasks = [];

      if (this.args.items && this.args.items.length) {
        description.args.items.forEach(x => {
          tasks.push(misc.describeAll.bind(null, x, "elements"));
        });
      } else {
        tasks.push(cb => {
          this.runProcessor(this.args.processor, {}, (er, items) => {
            if (er) return cb(er);
            const services = this.getServices();
            items.forEach(option => {
              misc.convert(this.factory, option, "elements", services);
            });
            description.args.items = items;
            async.parallel(
              items.map(element =>
                misc.describeAll.bind(null, element, "elements")
              ),
              cb
            );
          });
        });
      }
      if (tasks.length)
        return async.parallel(tasks, er => {
          if (er) return fn(er);
          return fn(null, description);
        });

      return fn(null, description);
    });
  }
  describeSync() {
    let element = super.describeSync(),
      args = element.args;
    if (args.items && args.items.length) {
      args.items.forEach(x => {
        misc.describeAllSync(x, "elements");
      });
    }
    return element;
  }
  invariants() {
    //checkout everything is fine
    elementInvariants._ensureArgs(this);
    if (!this.args.processor && (!this.args.items || !this.args.items.length))
      _warn(
        "All selectsets/option groups must either have a processor or atleast one element in its items.PLEASE NOTE: This will result in exception in production"
      );

    if (this.args.items)
      for (var i = this.args.items.length - 1; i >= 0; i--) {
        let curr = this.args.items[i];
        if (typeof curr.id === "undefined")
          throw new Error("All selectset options must have a valid id");
      }
  }
}

module.exports = Selectset;
