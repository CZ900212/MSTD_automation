// 反序列化防篡改快照：读取任何跨信任边界的对象前，先按描述符整体校验——
// 拒绝 getter/setter/Proxy/多余键/Symbol 键，杜绝校验或遥测期间执行外来代码。
// context-envelope 与 policy-eval 共用此处，规则只许在这一个文件里演进。
import { types as utilTypes } from "node:util";

export function snapshotDataObject(value, label, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new Error(`${label} 必须是 plain object`);
  }
  const allowed = new Set(allowedKeys);
  const names = Object.getOwnPropertyNames(value);
  if (names.some((key) => !allowed.has(key)) || Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} 字段非法`);
  }
  const out = {};
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || "get" in descriptor || "set" in descriptor) {
      throw new Error(`${label} accessor 非法`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function assertPlainArray(value, label) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) throw new Error(`${label} 必须是 array`);
  const allowed = new Set(["length"]);
  for (let index = 0; index < value.length; index += 1) allowed.add(String(index));
  if (
    Object.getOwnPropertyNames(value).some((key) => !allowed.has(key))
    || Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new Error(`${label} 字段非法`);
  }
}

function elementDescriptor(value, index, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  if (!descriptor || "get" in descriptor || "set" in descriptor) {
    throw new Error(`${label} accessor 非法`);
  }
  return descriptor;
}

export function snapshotArray(value, label, mapper) {
  assertPlainArray(value, label);
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    out.push(mapper(elementDescriptor(value, index, label).value, index));
  }
  return out;
}

export function stringListSnapshot(value, label) {
  assertPlainArray(value, label);
  const copy = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = elementDescriptor(value, index, label);
    if (typeof descriptor.value !== "string" || !descriptor.value) throw new Error(`${label} 非法`);
    copy.push(descriptor.value);
  }
  return copy;
}
