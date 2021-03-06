const FurmlyElement = require("../element"),
  misc = require("../element-utils"),
  async = require("async"),
  _ = require("lodash"),
  _warn = misc.warn(require("debug")("element:list")),
  elementInvariants = misc.elementInvariants;

class List extends FurmlyElement {
  constructor(opts, factory) {
    super(opts);
    //add invariants here.
    this.invariants();
    const params = super.getServices();
    if (this.hasDirectItemTemplate())
      misc.convert(factory, this.args, "itemTemplate", params);
    if (this.hasIndirectItemTemplate())
      misc.convert(factory, this.args.itemTemplate, "template", params);
    if (this.hasBehaviourExtension())
      misc.convert(factory, this.args.behavior, "extension", params);
  }
  describeSync() {
    let element = super.describeSync(),
      args = element.args;
    if (this.hasDirectItemTemplate())
      misc.describeAllSync(args, "itemTemplate");
    if (this.hasIndirectItemTemplate())
      misc.describeAllSync(args.itemTemplate, "template");

    if (this.hasBehaviourExtension())
      misc.describeAllSync(args.behavior, "extension");
    element.args = args;
    return element;
  }
  describe(fn) {
    super.describe((er, description) => {
      if (er) return fn(er);
      let tasks = [];
      if (this.hasDirectItemTemplate()) {
        tasks.push(
          misc.describeAll.bind(null, description.args, "itemTemplate")
        );
      }
      if (this.hasIndirectItemTemplate()) {
        tasks.push(
          misc.describeAll.bind(null, description.args.itemTemplate, "template")
        );
      }

      if (this.hasBehaviourExtension())
        tasks.push(
          misc.describeAll.bind(null, description.args.behavior, "extension")
        );
      if (tasks.length)
        return async.parallel(tasks, er => {
          if (er) return fn(er);
          return fn(null, description);
        });

      fn(null, description);
    });
  }
  hasDirectItemTemplate() {
    return (
      this.args.itemTemplate &&
      Array.prototype.isPrototypeOf(this.args.itemTemplate)
    );
  }
  hasIndirectItemTemplate() {
    return (
      this.args.itemTemplate &&
      !Array.prototype.isPrototypeOf(this.args.itemTemplate) &&
      Array.prototype.isPrototypeOf(this.args.itemTemplate.template)
    );
  }
  hasBehaviourExtension() {
    return this.args.behavior && this.args.behavior.extension;
  }
  invariants() {
    //checkout everything is fine
    elementInvariants._ensureArgs(this);

    if (
      this.args.itemTemplate &&
      !Array.prototype.isPrototypeOf(this.args.itemTemplate) &&
      (!this.args.itemTemplate.furmly_ref || !this.args.template_ref)
    )
      _warn(
        "itemTemplate does not contain furmly_ref but its template is not directly an array"
      );

    if (
      this.args.behavior &&
      this.args.behavior.extension &&
      !Array.prototype.isPrototypeOf(this.args.behavior.extension)
    )
      throw new Error("All template extensions must be arrays");
  }
}

module.exports = List;
