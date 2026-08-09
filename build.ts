import { rmSync } from "node:fs";

type Distribution = {
  entrypoint: string;
  filename: string;
  globalName: string;
  target: "browser" | "node";
  external?: string[];
};

async function compile(options: Bun.BuildConfig): Promise<string> {
  const result = await Bun.build(options);
  if (!result.success) {
    const messages: string[] = new Array(result.logs.length);
    for (let index = 0; index < result.logs.length; index += 1) {
      messages[index] = result.logs[index].message;
    }
    throw new Error(`Bun build failed:\n${messages.join("\n")}`);
  }
  if (result.outputs.length !== 1) {
    throw new Error(`Bun build produced ${result.outputs.length} outputs instead of one.`);
  }
  return result.outputs[0].text();
}

async function buildDistribution(distribution: Distribution): Promise<void> {
  const dependencies = distribution.external ?? [];
  const compiled = await compile({
    entrypoints: [distribution.entrypoint],
    external: dependencies,
    format: "cjs",
    target: distribution.target
  });
  const amdArguments = dependencies.map((dependency) => JSON.stringify(dependency)).join(", ");
  const amdParameters = dependencies.map((_, index) => `dependency${index}`).join(", ");
  const dependencyCases = dependencies
    .map((dependency, index) => `            if (id === ${JSON.stringify(dependency)}) { return dependency${index}; }`)
    .join("\n");
  const amdFactory =
    dependencies.length === 0
      ? "define(function () { return factory(null); });"
      : `define([${amdArguments}], function (${amdParameters}) {
            return factory(function (id) {
${dependencyCases}
                throw new Error("Unsupported external module: " + id);
            });
        });`;
  const umd = `(function (root, factory) {
    if (typeof module === "object" && module && module.exports) {
        module.exports = factory(require);
        return;
    }
    if (typeof define === "function" && define.amd) {
        ${amdFactory}
        return;
    }
    root.${distribution.globalName} = factory(
        typeof root.require === "function" ? root.require : null,
    );
})(typeof globalThis === "object" ? globalThis : this, function (externalRequire) {
    const module = { exports: {} };
    const exports = module.exports;
    const require = externalRequire ?? function (id) {
        throw new Error("External module is unavailable in this runtime: " + id);
    };
${compiled}
    const value = module.exports;
    return value && value.__esModule && "default" in value
        ? value.default
        : value;
});
`;
  const output = `./dist/${distribution.filename}.js`;
  await Bun.write(output, umd);

  const minifier = new Bun.Transpiler({
    loader: "js",
    minifyWhitespace: true,
    target: distribution.target
  });
  await Bun.write(`./dist/${distribution.filename}.min.js`, minifier.transformSync(umd));
}

rmSync("./dist", { force: true, recursive: true });

await buildDistribution({
  entrypoint: "./src/web.ts",
  filename: "iludb",
  globalName: "IluDB",
  target: "browser"
});

await buildDistribution({
  entrypoint: "./src/plugins/node-json.ts",
  filename: "plugins/node-json",
  globalName: "IluDBNodeJSONPlugin",
  target: "node",
  external: ["fs"]
});

await Bun.write("./dist/iludb.d.ts", Bun.file("./types/iludb.d.ts"));
await Bun.write("./dist/plugins/node-json.d.ts", Bun.file("./types/plugins/node-json.d.ts"));

export {};
