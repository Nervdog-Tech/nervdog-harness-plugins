/**
 * NERVDOG Harness brand, browser half: the husky sticker in `sidebar.brand.mark` and, in `sidebar.brand.name`, the
 * nervdog.com footer wordmark followed by "Harness". build.mjs replaces the FONT and MARK placeholders with data URLs and
 * wraps this file in the client module loader.
 */
var React = require("react");
var h = React.createElement;

var FONT = "__FONT_DATA__";
var MARK = "__MARK_DATA__";

/** nervdog.com footer wordmark rules (site CSS .wordmark / .wordmark-reg with the footer variables), class names prefixed. */
var CSS = [
  "@font-face { font-family: nervdog-luckiest; src: url(" + FONT + ") format('truetype'); font-display: block; }",
  ".nervdog-brand { display: inline-flex; align-items: center; gap: 6px; height: 24px; white-space: nowrap; }",
  ".nervdog-wm { display: inline-flex; align-items: flex-start; --wm-size: 16px; --wm-ring: #ffffff; --wm-nerv: #ffffff; --wm-gap: #3f4a66; --wm-key: #fe9037; }",
  ".nervdog-wordmark { z-index: 0; font-family: nervdog-luckiest, sans-serif; font-size: var(--wm-size); font-weight: 400; letter-spacing: .02em; white-space: nowrap; padding: .14em .12em .06em; line-height: 1; display: inline-block; position: relative; }",
  ".nervdog-wordmark::before, .nervdog-wordmark::after { content: attr(data-text); z-index: -1; position: absolute; top: .14em; left: .12em; }",
  ".nervdog-wordmark::before { z-index: -2; color: var(--wm-ring); -webkit-text-stroke: .27em var(--wm-ring); text-shadow: 0 .07em 0 var(--wm-ring); }",
  ".nervdog-wordmark::after { color: var(--wm-gap); -webkit-text-stroke: .11em var(--wm-gap); }",
  ".nervdog-wordmark .nervdog-nerv { color: var(--wm-nerv); }",
  ".nervdog-wordmark .nervdog-dog { color: var(--wm-key); }",
  ".nervdog-wordmark-reg { font-weight: 800; font-size: calc(var(--wm-size) * .42); letter-spacing: 0; color: currentColor; margin-left: .1em; line-height: 1; }",
  ".nervdog-harness { font-size: 17px; font-weight: 600; letter-spacing: .02em; }",
].join("\n");

/** Husky sticker at the requested square edge; `className` is the host's geometry class, when it passes one. */
function NervdogMark(props) {
  var size = props.size;
  return h("img", {
    src: MARK, width: size, height: size, alt: "", draggable: false, className: props.className,
    style: { display: "block", width: size, height: size, borderRadius: Math.round(size / 4) },
  });
}

/** Footer wordmark with the registered mark, then "Harness". */
function NervdogName() {
  return h(React.Fragment, null,
    h("style", null, CSS),
    h("span", { className: "nervdog-brand" },
      h("span", { className: "nervdog-wm" },
        h("span", { className: "nervdog-wordmark", "data-text": "NERVDOG" },
          h("span", { className: "nervdog-nerv" }, "NERV"),
          h("span", { className: "nervdog-dog" }, "DOG")),
        h("span", { className: "nervdog-wordmark-reg" }, "®")),
      h("span", { className: "nervdog-harness" }, "Harness")));
}

var inject = ["slots"];

/** Registers the sidebar mark and name and the blank-session headline mark; priority -10 shadows other occupants (default 0) without disabling them. */
function apply(ctx) {
  ctx.slots.inject("sidebar.brand.mark", function () {
    return ctx.slots.inject("sidebar.brand.name", function* () {
      yield ctx.slots.register({ name: "sidebar.brand.mark", priority: -10 }, NervdogMark);
      yield ctx.slots.register({ name: "sidebar.brand.name", priority: -10 }, NervdogName);
    });
  });
  ctx.slots.inject("conversation.hero.brand.mark", function () {
    return ctx.slots.register({ name: "conversation.hero.brand.mark", priority: -10 }, NervdogMark);
  });
}

exports.apply = apply;
exports.inject = inject;
