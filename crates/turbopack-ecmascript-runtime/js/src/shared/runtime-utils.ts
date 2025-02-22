/**
 * This file contains runtime types and functions that are shared between all
 * TurboPack ECMAScript runtimes.
 *
 * It will be prepended to the runtime code of each runtime.
 */

/* eslint-disable @next/next/no-assign-module-variable */

/// <reference path="./runtime-types.d.ts" />

interface Exports {
  __esModule?: boolean;

  [key: string]: any;
}

type EsmNamespaceObject = Record<string, any>;

const REEXPORTED_OBJECTS = Symbol("reexported objects");

interface BaseModule {
  exports: Exports | Promise<Exports> | AsyncModulePromise;
  error: Error | undefined;
  loaded: boolean;
  id: ModuleId;
  children: ModuleId[];
  parents: ModuleId[];
  namespaceObject?:
    | EsmNamespaceObject
    | Promise<EsmNamespaceObject>
    | AsyncModulePromise<EsmNamespaceObject>;
  [REEXPORTED_OBJECTS]?: any[];
}

interface Module extends BaseModule {}

type RequireContextMap = Record<ModuleId, RequireContextEntry>;

interface RequireContextEntry {
  id: () => ModuleId;
}

interface RequireContext {
  (moduleId: ModuleId): Exports | EsmNamespaceObject;

  keys(): ModuleId[];

  resolve(moduleId: ModuleId): ModuleId;
}

type GetOrInstantiateModuleFromParent = (
  moduleId: ModuleId,
  parentModule: Module
) => Module;

type CommonJsRequireContext = (
  entry: RequireContextEntry,
  parentModule: Module
) => Exports;

const hasOwnProperty = Object.prototype.hasOwnProperty;
const toStringTag = typeof Symbol !== "undefined" && Symbol.toStringTag;

function defineProp(
  obj: any,
  name: PropertyKey,
  options: PropertyDescriptor & ThisType<any>
) {
  if (!hasOwnProperty.call(obj, name))
    Object.defineProperty(obj, name, options);
}

/**
 * Adds the getters to the exports object.
 */
function esm(exports: Exports, getters: Record<string, () => any>) {
  defineProp(exports, "__esModule", { value: true });
  if (toStringTag) defineProp(exports, toStringTag, { value: "Module" });
  for (const key in getters) {
    defineProp(exports, key, { get: getters[key], enumerable: true });
  }
}

/**
 * Makes the module an ESM with exports
 */
function esmExport(
  module: Module,
  exports: Exports,
  getters: Record<string, () => any>
) {
  module.namespaceObject = module.exports;
  esm(exports, getters);
}

function ensureDynamicExports(module: Module, exports: Exports) {
  let reexportedObjects = module[REEXPORTED_OBJECTS];

  if (!reexportedObjects) {
    reexportedObjects = module[REEXPORTED_OBJECTS] = [];
    module.exports = module.namespaceObject = new Proxy(exports, {
      get(target, prop) {
        if (
          hasOwnProperty.call(target, prop) ||
          prop === "default" ||
          prop === "__esModule"
        ) {
          return Reflect.get(target, prop);
        }
        for (const obj of reexportedObjects!) {
          const value = Reflect.get(obj, prop);
          if (value !== undefined) return value;
        }
        return undefined;
      },
      ownKeys(target) {
        const keys = Reflect.ownKeys(target);
        for (const obj of reexportedObjects!) {
          for (const key of Reflect.ownKeys(obj)) {
            if (key !== "default" && !keys.includes(key)) keys.push(key);
          }
        }
        return keys;
      },
    });
  }
}

/**
 * Dynamically exports properties from an object
 */
function dynamicExport(
  module: Module,
  exports: Exports,
  object: Record<string, any>
) {
  ensureDynamicExports(module, exports);

  if (typeof object === "object" && object !== null) {
    module[REEXPORTED_OBJECTS]!.push(object);
  }
}

/**
 * Access one entry from a mapping from name to functor.
 */
function moduleLookup(
  map: Record<string, () => any>,
  name: string,
  returnPromise: boolean = false
) {
  if (hasOwnProperty.call(map, name)) {
    return map[name]();
  }
  const e = new Error(`Cannot find module '${name}'`);
  (e as any).code = "MODULE_NOT_FOUND";
  if (returnPromise) {
    return Promise.resolve().then(() => {
      throw e;
    });
  } else {
    throw e;
  }
}

function exportValue(module: Module, value: any) {
  module.exports = value;
}

function exportNamespace(module: Module, namespace: any) {
  module.exports = module.namespaceObject = namespace;
}

function createGetter(obj: Record<string | symbol, any>, key: string | symbol) {
  return () => obj[key];
}

/**
 * @returns prototype of the object
 */
const getProto: (obj: any) => any = Object.getPrototypeOf
  ? (obj) => Object.getPrototypeOf(obj)
  : (obj) => obj.__proto__;

/** Prototypes that are not expanded for exports */
const LEAF_PROTOTYPES = [null, getProto({}), getProto([]), getProto(getProto)];

/**
 * @param raw
 * @param ns
 * @param allowExportDefault
 *   * `false`: will have the raw module as default export
 *   * `true`: will have the default property as default export
 */
function interopEsm(
  raw: Exports,
  ns: EsmNamespaceObject,
  allowExportDefault?: boolean
) {
  const getters: { [s: string]: () => any } = Object.create(null);
  for (
    let current = raw;
    (typeof current === "object" || typeof current === "function") &&
    !LEAF_PROTOTYPES.includes(current);
    current = getProto(current)
  ) {
    for (const key of Object.getOwnPropertyNames(current)) {
      getters[key] = createGetter(raw, key);
    }
  }

  // this is not really correct
  // we should set the `default` getter if the imported module is a `.cjs file`
  if (!(allowExportDefault && "default" in getters)) {
    getters["default"] = () => raw;
  }

  esm(ns, getters);
  return ns;
}

function esmImport(
  sourceModule: Module,
  id: ModuleId
): Exclude<Module["namespaceObject"], undefined> {
  const module = getOrInstantiateModuleFromParent(id, sourceModule);
  if (module.error) throw module.error;

  // any ES module has to have `module.namespaceObject` defined.
  if (module.namespaceObject) return module.namespaceObject;

  // only ESM can be an async module, so we don't need to worry about exports being a promise here.
  const raw = module.exports;
  return (module.namespaceObject = interopEsm(
    raw,
    {},
    raw && (raw as any).__esModule
  ));
}

// Add a simple runtime require so that environments without one can still pass
// `typeof require` CommonJS checks so that exports are correctly registered.
const runtimeRequire =
  typeof require === "function"
    ? require
    : function require() {
        throw new Error("Unexpected use of runtime require");
      };

function commonJsRequire(sourceModule: Module, id: ModuleId): Exports {
  const module = getOrInstantiateModuleFromParent(id, sourceModule);
  if (module.error) throw module.error;
  return module.exports;
}

type RequireContextFactory = (map: RequireContextMap) => RequireContext;

function requireContext(
  sourceModule: Module,
  map: RequireContextMap
): RequireContext {
  function requireContext(id: ModuleId): Exports {
    const entry = map[id];

    if (!entry) {
      throw new Error(
        `module ${id} is required from a require.context, but is not in the context`
      );
    }

    return commonJsRequireContext(entry, sourceModule);
  }

  requireContext.keys = (): ModuleId[] => {
    return Object.keys(map);
  };

  requireContext.resolve = (id: ModuleId): ModuleId => {
    const entry = map[id];

    if (!entry) {
      throw new Error(
        `module ${id} is resolved from a require.context, but is not in the context`
      );
    }

    return entry.id();
  };

  return requireContext;
}

/**
 * Returns the path of a chunk defined by its data.
 */
function getChunkPath(chunkData: ChunkData): ChunkPath {
  return typeof chunkData === "string" ? chunkData : chunkData.path;
}

function isPromise<T = any>(maybePromise: any): maybePromise is Promise<T> {
  return (
    maybePromise != null &&
    typeof maybePromise === "object" &&
    "then" in maybePromise &&
    typeof maybePromise.then === "function"
  );
}

function isAsyncModuleExt<T extends {}>(obj: T): obj is AsyncModuleExt & T {
  return turbopackQueues in obj;
}

function createPromise<T>() {
  let resolve: (value: T | PromiseLike<T>) => void;
  let reject: (reason?: any) => void;

  const promise = new Promise<T>((res, rej) => {
    reject = rej;
    resolve = res;
  });

  return {
    promise,
    resolve: resolve!,
    reject: reject!,
  };
}

// everything below is adapted from webpack
// https://github.com/webpack/webpack/blob/6be4065ade1e252c1d8dcba4af0f43e32af1bdc1/lib/runtime/AsyncModuleRuntimeModule.js#L13

const turbopackQueues = Symbol("turbopack queues");
const turbopackExports = Symbol("turbopack exports");
const turbopackError = Symbol("turbopack error");

type AsyncQueueFn = (() => void) & { queueCount: number };
type AsyncQueue = AsyncQueueFn[] & { resolved: boolean };

function resolveQueue(queue?: AsyncQueue) {
  if (queue && !queue.resolved) {
    queue.resolved = true;
    queue.forEach((fn) => fn.queueCount--);
    queue.forEach((fn) => (fn.queueCount-- ? fn.queueCount++ : fn()));
  }
}

type Dep = Exports | AsyncModulePromise | Promise<Exports>;

type AsyncModuleExt = {
  [turbopackQueues]: (fn: (queue: AsyncQueue) => void) => void;
  [turbopackExports]: Exports;
  [turbopackError]?: any;
};

type AsyncModulePromise<T = Exports> = Promise<T> & AsyncModuleExt;

function wrapDeps(deps: Dep[]): AsyncModuleExt[] {
  return deps.map((dep) => {
    if (dep !== null && typeof dep === "object") {
      if (isAsyncModuleExt(dep)) return dep;
      if (isPromise(dep)) {
        const queue: AsyncQueue = Object.assign([], { resolved: false });

        const obj: AsyncModuleExt = {
          [turbopackExports]: {},
          [turbopackQueues]: (fn: (queue: AsyncQueue) => void) => fn(queue),
        };

        dep.then(
          (res) => {
            obj[turbopackExports] = res;
            resolveQueue(queue);
          },
          (err) => {
            obj[turbopackError] = err;
            resolveQueue(queue);
          }
        );

        return obj;
      }
    }

    const ret: AsyncModuleExt = {
      [turbopackExports]: dep,
      [turbopackQueues]: () => {},
    };

    return ret;
  });
}

function asyncModule(
  module: Module,
  body: (
    handleAsyncDependencies: (
      deps: Dep[]
    ) => Exports[] | Promise<() => Exports[]>,
    asyncResult: (err?: any) => void
  ) => void,
  hasAwait: boolean
) {
  const queue: AsyncQueue | undefined = hasAwait
    ? Object.assign([], { resolved: true })
    : undefined;

  const depQueues: Set<AsyncQueue> = new Set();

  ensureDynamicExports(module, module.exports);
  const exports = module.exports;

  const { resolve, reject, promise: rawPromise } = createPromise<Exports>();

  const promise: AsyncModulePromise = Object.assign(rawPromise, {
    [turbopackExports]: exports,
    [turbopackQueues]: (fn) => {
      queue && fn(queue);
      depQueues.forEach(fn);
      promise["catch"](() => {});
    },
  } satisfies AsyncModuleExt);

  module.exports = module.namespaceObject = promise;

  function handleAsyncDependencies(deps: Dep[]) {
    const currentDeps = wrapDeps(deps);

    const getResult = () =>
      currentDeps.map((d) => {
        if (d[turbopackError]) throw d[turbopackError];
        return d[turbopackExports];
      });

    const { promise, resolve } = createPromise<() => Exports[]>();

    const fn: AsyncQueueFn = Object.assign(() => resolve(getResult), {
      queueCount: 0,
    });

    function fnQueue(q: AsyncQueue) {
      if (q !== queue && !depQueues.has(q)) {
        depQueues.add(q);
        if (q && !q.resolved) {
          fn.queueCount++;
          q.push(fn);
        }
      }
    }

    currentDeps.map((dep) => dep[turbopackQueues](fnQueue));

    return fn.queueCount ? promise : getResult();
  }

  function asyncResult(err?: any) {
    if (err) {
      reject((promise[turbopackError] = err));
    } else {
      resolve(exports);
    }

    resolveQueue(queue);
  }

  body(handleAsyncDependencies, asyncResult);

  if (queue) {
    queue.resolved = false;
  }
}

/**
 * A pseudo, `fake` URL object to resolve to the its relative path.
 * When urlrewritebehavior is set to relative, calls to the `new URL()` will construct url without base using this
 * runtime function to generate context-agnostic urls between different rendering context, i.e ssr / client to avoid
 * hydration mismatch.
 *
 * This is largely based on the webpack's existing implementation at
 * https://github.com/webpack/webpack/blob/87660921808566ef3b8796f8df61bd79fc026108/lib/runtime/RelativeUrlRuntimeModule.js
 */
var relativeURL = function (this: any, inputUrl: string) {
  const realUrl = new URL(inputUrl, "x:/");
  const values: Record<string, any> = {};
  for (var key in realUrl) values[key] = (realUrl as any)[key];
  values.href = inputUrl;
  values.pathname = inputUrl.replace(/[?#].*/, "");
  values.origin = values.protocol = "";
  values.toString = values.toJSON = (..._args: Array<any>) => inputUrl;
  for (var key in values)
    Object.defineProperty(this, key, {
      enumerable: true,
      configurable: true,
      value: values[key],
    });
};

relativeURL.prototype = URL.prototype;
