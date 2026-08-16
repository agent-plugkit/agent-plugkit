import { CommandError } from '../core/errors.js';
import {
  COMPONENT_TYPES,
  addedComponentEntry,
  createInitialPluginConfig,
  dumpPluginYaml,
  isComponentType,
  isPluginName,
  skillEntry,
  type ComponentType,
} from '../application/plugin-scaffold.js';

export {
  COMPONENT_TYPES,
  addedComponentEntry,
  createInitialPluginConfig,
  dumpPluginYaml,
  skillEntry,
  type ComponentType,
};

export function parseComponentType(type: string): ComponentType {
  if (isComponentType(type)) return type;
  throw new CommandError(`组件类型非法: ${type}. 可选值: ${COMPONENT_TYPES.join(', ')}`);
}

export function assertKebabName(name: string, label: string): void {
  if (!isPluginName(name)) {
    throw new CommandError(`${label} 必须使用 kebab-case 小写名称: ${name}`);
  }
}
