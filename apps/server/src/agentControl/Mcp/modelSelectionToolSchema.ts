/**
 * The JSON schema of a tool's `modelSelection` argument. A leaf module, so a tool set that loads
 * through `import()` (`projectCopyTools.ts`) can share it without a static import of the
 * boot-loaded tool modules, which would split those into extra boot chunks.
 *
 * @module agentControl/Mcp/modelSelectionToolSchema
 */
export const modelSelectionSchema = {
  type: "object",
  properties: {
    instanceId: { type: "string", description: "Provider instance ID from ryco_capabilities." },
    model: { type: "string", description: "Exact model slug from that provider instance." },
    options: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          value: { anyOf: [{ type: "string" }, { type: "boolean" }] },
        },
        required: ["id", "value"],
        additionalProperties: false,
      },
    },
  },
  required: ["instanceId", "model"],
  additionalProperties: false,
} as const;
