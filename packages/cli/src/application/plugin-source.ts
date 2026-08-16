import AjvModule, {
  Ajv as AjvClass,
  type ErrorObject,
  type Options,
} from "ajv";
import yaml from "js-yaml";
import { pluginYamlSchema, type PluginYaml } from "../schema/plugin-yaml.js";

const AjvConstructor = AjvModule as unknown as new (
  options?: Options,
) => AjvClass;
const ajv = new AjvConstructor({ allErrors: true });
const validatePluginYamlSchema = ajv.compile(pluginYamlSchema);

export interface PluginSourceSchemaIssue {
  readonly instancePath: string;
  readonly message: string;
  readonly keyword: string;
  readonly missingProperty?: string;
  readonly additionalProperty?: string;
}

export type ParsePluginSourceResult =
  | {
      readonly status: "valid";
      readonly value: PluginYaml;
    }
  | {
      readonly status: "invalid-yaml";
      readonly message: string;
    }
  | {
      readonly status: "invalid-schema";
      readonly message: string;
      readonly issues: readonly PluginSourceSchemaIssue[];
    };

export type ValidatePluginYamlValueResult =
  | {
      readonly status: "valid";
      readonly value: PluginYaml;
    }
  | {
      readonly status: "invalid-schema";
      readonly message: string;
      readonly issues: readonly PluginSourceSchemaIssue[];
    };

function schemaIssues(
  errors: readonly ErrorObject[] | null | undefined,
): readonly PluginSourceSchemaIssue[] {
  return (errors ?? []).map((error: ErrorObject) => ({
    instancePath: error.instancePath || "/",
    message: error.message ?? "不符合当前格式",
    keyword: error.keyword,
    ...(typeof error.params.missingProperty === "string"
      ? { missingProperty: error.params.missingProperty }
      : {}),
    ...(typeof error.params.additionalProperty === "string"
      ? { additionalProperty: error.params.additionalProperty }
      : {}),
  }));
}

/**
 * Validates an already parsed value through the same authoritative Ajv
 * schema used by CLI parsing. Other internal consumers call this seam instead
 * of maintaining a second approximation.
 */
export function validatePluginYamlValue(
  value: unknown,
): ValidatePluginYamlValueResult {
  if (!validatePluginYamlSchema(value)) {
    const issues = schemaIssues(validatePluginYamlSchema.errors);
    return {
      status: "invalid-schema",
      message: formatPluginSchemaError(issues),
      issues,
    };
  }
  return { status: "valid", value: value as PluginYaml };
}

/**
 * Parses the canonical plugin declaration without reading or writing the file
 * system. Callers decide how to present the structured result.
 */
export function parsePluginYamlSource(raw: string): ParsePluginSourceResult {
  let data: unknown;
  try {
    data = yaml.load(raw) as unknown;
  } catch (error) {
    return {
      status: "invalid-yaml",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return validatePluginYamlValue(data);
}

export function formatPluginSchemaError(
  issues: readonly PluginSourceSchemaIssue[],
): string {
  const details = issues
    .map((issue) => `  - ${issue.instancePath}: ${issue.message}`)
    .join("\n");
  return `plugin.yaml validation failed:\n${details}`;
}
