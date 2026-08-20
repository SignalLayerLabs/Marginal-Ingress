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

function unwrap(node) {
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "ChainExpression"
  ) {
    return unwrap(node.expression);
  }
  return node;
}

function isIncomingValue(node) {
  return isIdentifier(unwrap(node), "value");
}

function memberName(node) {
  if (!node.computed && node.property.type === "Identifier")
    return node.property.name;
  if (
    node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return undefined;
}

function isRequestHeaders(node) {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    !node.optional &&
    isIncomingValue(node.object) &&
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
      consoleAccess: "Console access is prohibited.",
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
          node.name === "console" &&
          !(
            node.parent?.type === "MemberExpression" &&
            node.parent.property === node
          )
        ) {
          report(node, "consoleAccess");
        }
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
        if (isIncomingValue(node.init) || isRequestHeaders(node.init)) {
          report(node, "requestMetadata");
        }
      },
      AssignmentExpression(node) {
        if (!adapter) return;
        if (isIncomingValue(node.right) || isRequestHeaders(node.right)) {
          report(node, "requestMetadata");
        }
      },
      MemberExpression(node) {
        const name = memberName(node);
        if (isIdentifier(node.object, "globalThis") && name === "console") {
          report(node, "consoleAccess");
        }
        if (!adapter) {
          if (production && (name === "headers" || name === "cf")) {
            report(node, "capability");
          }
          return;
        }
        if (isIncomingValue(node.object) && (node.computed || node.optional)) {
          report(node, "requestMetadata");
          return;
        }
        if (isIncomingValue(node.object) && name === "cf") {
          report(node, "requestMetadata");
        }
        if (
          isRequestHeaders(node) &&
          !(
            node.parent?.type === "MemberExpression" &&
            node.parent.object === node
          )
        ) {
          report(node, "requestMetadata");
        }
      },
      CallExpression(node) {
        if (!adapter) return;
        if (
          node.arguments.some((argument) => isRequestHeaders(unwrap(argument)))
        ) {
          report(node, "requestMetadata");
          return;
        }
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
