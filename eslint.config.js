import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const allowedRequestHeaders = new Set([
  "Content-Type",
  "Content-Length",
  "Idempotency-Key",
]);

const requestHeaderPolicy = {
  meta: {
    type: "problem",
    messages: {
      disallowed:
        "Only Content-Type, Content-Length, and Idempotency-Key may be read from request.headers.",
      requestMetadata: "request.cf must not be accessed.",
    },
    schema: [],
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          node.object.name === "request" &&
          ((node.computed &&
            node.property.type === "Literal" &&
            node.property.value === "cf") ||
            (!node.computed &&
              node.property.type === "Identifier" &&
              node.property.name === "cf"))
        ) {
          context.report({ node, messageId: "requestMetadata" });
        }
      },
      CallExpression(node) {
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.computed ||
          node.callee.property.type !== "Identifier" ||
          node.callee.property.name !== "get" ||
          node.callee.object.type !== "MemberExpression" ||
          node.callee.object.computed ||
          node.callee.object.property.type !== "Identifier" ||
          node.callee.object.property.name !== "headers" ||
          node.callee.object.object.type !== "Identifier" ||
          node.callee.object.object.name !== "request"
        ) {
          return;
        }
        const [header] = node.arguments;
        if (
          header?.type !== "Literal" ||
          typeof header.value !== "string" ||
          !allowedRequestHeaders.has(header.value)
        ) {
          context.report({ node, messageId: "disallowed" });
        }
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: ["node_modules", "coverage", ".wrangler"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.worker,
    },
    plugins: { privacy: { rules: { "request-headers": requestHeaderPolicy } } },
    rules: {
      "no-console": "error",
      "privacy/request-headers": "error",
    },
  },
  prettier,
);
