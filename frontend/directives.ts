// The x-md directive: builds DOM from the markdown tree with createElement and text nodes only.

import { markdownTree, type MdBlock, type TreeNode } from "./markdown.ts";

interface DirectiveUtils {
    effect(callback: () => void): unknown;
    evaluateLater(expression: string): (callback: (value: unknown) => void) => void;
}

export function registerMd(): void {
    // Builds DOM from the tree of markdownTree(): createElement and text nodes
    // only, so a model answer is never parsed as HTML.
    const buildNode = (node: TreeNode): Node => {
        if (typeof node === "string") return document.createTextNode(node);
        const element = document.createElement(node.tag);
        if (node.cls) element.className = node.cls;
        for (const [key, value] of Object.entries(node.attrs)) {
            element.setAttribute(key, value);
        }
        for (const child of node.children) element.append(buildNode(child));
        return element;
    };

    // x-md="blocks": renders the blocks of parseMarkdown() into the element.
    Alpine.directive(
        "md",
        (
            root: HTMLElement,
            { expression }: { expression: string },
            { effect, evaluateLater }: DirectiveUtils,
        ) => {
            const read = evaluateLater(expression);
            effect(() =>
                read((blocks) =>
                    root.replaceChildren(buildNode(markdownTree(blocks as MdBlock[]))),
                ),
            );
        },
    );
}
