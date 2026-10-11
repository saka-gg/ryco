import { Schema, SchemaAST } from "effect";

export const TrimmedString = Schema.Trim;
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const UnexpectedKeyValue = Schema.Never.annotate({ message: "Unexpected key" });

function rejectUndeclaredKeys(
  propertySignatures: ReadonlyArray<SchemaAST.PropertySignature>,
  indexSignatures: ReadonlyArray<SchemaAST.IndexSignature>,
): ReadonlyArray<SchemaAST.IndexSignature> {
  const declared = new Set<PropertyKey>(propertySignatures.map((property) => property.name));
  const covered = indexSignatures.map((index) => Schema.is(Schema.make(index.parameter)));
  const undeclaredKey = Schema.String.check(
    Schema.makeFilter((key: string) => !declared.has(key) && !covered.some((is) => is(key))),
  );
  return [
    ...indexSignatures,
    new SchemaAST.IndexSignature(undeclaredKey.ast, UnexpectedKeyValue.ast),
  ];
}

function rejectExcessPropertiesEncoding(ast: SchemaAST.AST): SchemaAST.Encoding | undefined {
  return ast.encoding?.map(
    (link) => new SchemaAST.Link(rejectExcessPropertiesAst(link.to), link.transformation),
  ) as SchemaAST.Encoding | undefined;
}

function rejectExcessPropertiesAst(ast: SchemaAST.AST): SchemaAST.AST {
  if (SchemaAST.isObjects(ast)) {
    const propertySignatures = ast.propertySignatures.map(
      (property) =>
        new SchemaAST.PropertySignature(property.name, rejectExcessPropertiesAst(property.type)),
    );
    const indexSignatures = ast.indexSignatures.map(
      (index) =>
        new SchemaAST.IndexSignature(index.parameter, rejectExcessPropertiesAst(index.type)),
    );
    return new SchemaAST.Objects(
      propertySignatures,
      rejectUndeclaredKeys(propertySignatures, indexSignatures),
      ast.annotations,
      ast.checks,
      rejectExcessPropertiesEncoding(ast),
      ast.context,
      ast.encodingChecks,
    );
  }
  if (SchemaAST.isUnion(ast)) {
    return new SchemaAST.Union(
      ast.types.map(rejectExcessPropertiesAst),
      ast.options,
      ast.annotations,
      ast.checks,
      rejectExcessPropertiesEncoding(ast),
      ast.context,
      ast.encodingChecks,
    );
  }
  if (SchemaAST.isArrays(ast)) {
    return new SchemaAST.Arrays(
      ast.isMutable,
      ast.elements.map(rejectExcessPropertiesAst),
      ast.rest.map(rejectExcessPropertiesAst),
      ast.annotations,
      ast.checks,
      rejectExcessPropertiesEncoding(ast),
      ast.context,
      ast.encodingChecks,
    );
  }
  return ast;
}

/**
 * Rejects keys a schema does not declare, at every object inside it (including
 * the encoded side of transformations), instead of silently dropping them.
 * Effect only rejects excess properties when the caller passes
 * `{ onExcessProperty: "error" }`, and RPC payload decoding passes no options,
 * so each object gains an index signature that accepts no value for an
 * undeclared key. Decoding, encoding and `Schema.is` all enforce it; the schema
 * keeps its type and API.
 */
export const rejectExcessProperties = <S extends Schema.Top>(schema: S): S =>
  schema.rebuild(rejectExcessPropertiesAst(schema.ast) as S["ast"]) as S;

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

/**
 * Construct a branded identifier. Enforces non-empty trimmed strings
 */
const makeEntityId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) => {
  return TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));
};

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProjectId = makeEntityId("ProjectId");
export type ProjectId = typeof ProjectId.Type;
export const EnvironmentId = makeEntityId("EnvironmentId");
export type EnvironmentId = typeof EnvironmentId.Type;
export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;
export const EventId = makeEntityId("EventId");
export type EventId = typeof EventId.Type;
export const MessageId = makeEntityId("MessageId");
export type MessageId = typeof MessageId.Type;
export const TurnId = makeEntityId("TurnId");
export type TurnId = typeof TurnId.Type;
export const AuthSessionId = makeEntityId("AuthSessionId");
export type AuthSessionId = typeof AuthSessionId.Type;

export const AtlassianConnectionId = makeEntityId("AtlassianConnectionId");
export type AtlassianConnectionId = typeof AtlassianConnectionId.Type;
export const AtlassianResourceId = makeEntityId("AtlassianResourceId");
export type AtlassianResourceId = typeof AtlassianResourceId.Type;

export const ProviderItemId = makeEntityId("ProviderItemId");
export type ProviderItemId = typeof ProviderItemId.Type;
export const RuntimeSessionId = makeEntityId("RuntimeSessionId");
export type RuntimeSessionId = typeof RuntimeSessionId.Type;
export const ContextHandoffId = makeEntityId("ContextHandoffId");
export type ContextHandoffId = typeof ContextHandoffId.Type;
export const RuntimeItemId = makeEntityId("RuntimeItemId");
export type RuntimeItemId = typeof RuntimeItemId.Type;
export const RuntimeRequestId = makeEntityId("RuntimeRequestId");
export type RuntimeRequestId = typeof RuntimeRequestId.Type;
export const RuntimeTaskId = makeEntityId("RuntimeTaskId");
export type RuntimeTaskId = typeof RuntimeTaskId.Type;
export const RuntimeSubagentId = makeEntityId("RuntimeSubagentId");
export type RuntimeSubagentId = typeof RuntimeSubagentId.Type;
export const ApprovalRequestId = makeEntityId("ApprovalRequestId");
export type ApprovalRequestId = typeof ApprovalRequestId.Type;
export const CheckpointRef = makeEntityId("CheckpointRef");
export type CheckpointRef = typeof CheckpointRef.Type;
