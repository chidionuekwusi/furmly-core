const FurmlyElement = require("../element"),
	misc = require("../element-utils"),
	elementInvariants = misc.elementInvariants;

class HtmlView extends FurmlyElement {
	constructor(props) {
		super(props);
		this.invariants();
		this.dynamicFields.push("args.html")
	}
	invariants() {
	//	elementInvariants._ensureArgs(this);

		if (this.args && this.args.html && typeof this.args.html !== "string")
			throw new Error("HtmlView args.html property must be a string");
	}
}

module.exports = HtmlView;
