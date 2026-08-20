import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const allowedRequestHeaders = new Set([
  "Content-Type",
  "Content-Length",
  "Idempotency-Key",
]);

function isProductionSource(filename) {
  return filename.replaceAll("\\", "/").includes("/src/");
}

function isAuditedIngressAdapter(filename) {
  return filename.replaceAll("\\", "/").endsWith("/src/ingress.ts");
}

function isIdentifier(node, name) {
  return node.type === "Identifier" && node.name === name;
}

function isRequestHeaders(node) {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    isIdentifier(node.object, "value") &&
    isIdentifier(node.property, "headers")
  );
}

const requestCapabilityPolicy = {
  meta: {
    type: "problem",
    messages: {
      disallowed:
        "Only direct get() reads of Content-Type, Content-Length, and Idempotency-Key are allowed on incoming headers.",
      requestMetadata: "Incoming request metadata must not be accessed.",
      capability:
        "Request and Headers capabilities are reserved for src/ingress.ts.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename;
    const production = isProductionSource(filename);
    const adapter = isAuditedIngressAdapter(filename);
    const report = (node, messageId) => context.report({ node, messageId });
    return {
      Identifier(node) {
        if (
          production &&
          !adapter &&
          (node.name === "Request" || node.name === "Headers")
        ) {
          report(node, "capability");
        }
      },
      VariableDeclarator(node) {
        if (!adapter || node.init === null) return;
        if (isIdentifier(node.init, "value") || isRequestHeaders(node.init)) {
          report(node, "requestMetadata");
        }
      },
      MemberExpression(node) {
        if (!adapter) return;
        if (isIdentifier(node.object, "value") && node.computed) {
          report(node, "requestMetadata");
          return;
        }
        if (
          isIdentifier(node.object, "value") &&
          !node.computed &&
          isIdentifier(node.property, "cf")
        ) {
          report(node, "requestMetadata");
        }
      },
      CallExpression(node) {
        if (!adapter) return;
        if (
          node.callee.type !== "MemberExpression" ||
          !isRequestHeaders(node.callee.object)
        ) {
          return;
        }
        const [header] = node.arguments;
        if (
          node.callee.computed ||
          !isIdentifier(node.callee.property, "get") ||
          header?.type !== "Literal" ||
          typeof header.value !== "string" ||
          !allowedRequestHeaders.has(header.value)
        ) {
          report(node, "disallowed");
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
    plugins: {
      privacy: { rules: { "request-capability": requestCapabilityPolicy } },
    },
    rules: {
      "no-console": "error",
      "privacy/request-capability": "error",
    },
  },
  prettier,
);
