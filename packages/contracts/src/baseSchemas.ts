import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaGetter from "effect/SchemaGetter";

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
 * What a client decodes in place of a union member a newer node added: the
 * union's tag key (`tag`) and the value this build does not know (`value`),
 * plus the fields the union keeps from every member (see
 * `ForwardCompatibleUnion`). A class, so no decoded payload, however it is
 * shaped, is ever mistaken for one.
 */
export class UnknownUnionMember<Tag extends string = string> {
  readonly tag: Tag;
  readonly value: string;
  constructor(tag: Tag, value: string) {
    this.tag = tag;
    this.value = value;
  }
}

export const isUnknownUnionMember = <A>(value: A): value is Extract<A, UnknownUnionMember> =>
  value instanceof UnknownUnionMember;

const knownUnionTags = (
  members: ReadonlyArray<Schema.Top & { readonly fields: object }>,
  tag: string,
): ReadonlySet<string> => {
  const tags = new Set<string>();
  for (const member of members) {
    const field = (member.fields as Record<string, unknown>)[tag] as
      | { readonly literal?: unknown; readonly literals?: ReadonlyArray<unknown> }
      | undefined;
    for (const literal of field?.literals ?? [field?.literal]) {
      if (typeof literal !== "string") {
        throw new Error(`Every ForwardCompatibleUnion member needs a string literal ${tag}.`);
      }
      tags.add(literal);
    }
  }
  return tags;
};

/**
 * A tagged union a client decodes from a newer node, which may send members
 * this build does not know. A member whose tag is unknown decodes to an
 * `UnknownUnionMember` that also carries the `kept` fields, which every member
 * has (an event's `sequence`, so a client's resume cursor can pass it); the
 * client skips it instead of failing the whole stream. A known tag whose
 * payload does not decode still fails, so a real defect stays loud.
 *
 * The known members stay one union that dispatches on the tag, so a known
 * member decodes once, on that union's own fast path; only a tag no member
 * claims reaches the fallback. Unknown members are decode-only: encoding one
 * fails. Only for what a node sends a client: persisted records and what a
 * client sends stay strict.
 */
export const ForwardCompatibleUnion = <
  const Members extends ReadonlyArray<Schema.Top & { readonly fields: object }>,
  const Tag extends string,
  const Kept extends Schema.Struct.Fields = {},
>(
  members: Members,
  tag: Tag,
  kept?: Kept,
): ForwardCompatibleUnion<Members, Tag, Kept> => {
  const known = knownUnionTags(members, tag);
  const keptFields: Schema.Struct.Fields = kept ?? {};
  const keptKeys = Object.keys(keptFields);
  if (keptKeys.some((key) => key === tag || key === "tag" || key === "value")) {
    throw new Error(`A ForwardCompatibleUnion cannot keep "${tag}", "tag" or "value".`);
  }
  const unknownMember = Schema.Struct({
    // First, so a known tag with a broken payload fails here at once.
    [tag]: Schema.String.check(
      Schema.makeFilter(
        (value: string) => !known.has(value) || `A known ${tag} must decode in full.`,
      ),
    ),
    ...keptFields,
  }).pipe(
    Schema.decodeTo(Schema.instanceOf(UnknownUnionMember<Tag>), {
      decode: SchemaGetter.transform((raw: Record<string, unknown>) => {
        const member = new UnknownUnionMember(tag, raw[tag] as string);
        for (const key of keptKeys) {
          if (Object.hasOwn(raw, key)) Object.assign(member, { [key]: raw[key] });
        }
        return member;
      }),
      encode: SchemaGetter.forbidden(() => `Unknown ${tag} values are never sent.`),
    }),
  );
  // Nested, not flat: in one flat union the fallback, which has no tag literal,
  // would be a candidate beside the matched member on every decode and take
  // the union off its single-candidate fast path.
  return Schema.Union([Schema.Union(members), unknownMember]) as unknown as ForwardCompatibleUnion<
    Members,
    Tag,
    Kept
  >;
};
export type ForwardCompatibleUnion<
  Members extends ReadonlyArray<Schema.Top>,
  Tag extends string,
  Kept extends Schema.Struct.Fields = {},
> = Schema.Codec<
  Members[number]["Type"] | (UnknownUnionMember<Tag> & Schema.Struct.Type<Kept>),
  Members[number]["Encoded"],
  Members[number]["DecodingServices"],
  Members[number]["EncodingServices"]
>;

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
