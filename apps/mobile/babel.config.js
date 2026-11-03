// React Compiler (enabled by `experiments.reactCompiler` in app.config.ts) runs
// on every file under apps/mobile/src. It stays off for packages/client-runtime,
// which Metro consumes as source and the web app shares, and for modules/*
// (native-module JS): without `sources` the preset would compile every
// non-node_modules file Metro transforms, so keep it. A function the compiler
// cannot model, such as try/finally in a component (see src/lib/runWhileBusy.ts),
// ships uncompiled. src/perf/reactCompilerCoverage.test.ts fails on a bailout
// that is not in its KNOWN_BAILOUTS list and on a listed function that compiles
// now; the only deliberate opt-out is a "use no memo" directive plus an entry
// there.
const REACT_COMPILER_SOURCES = /[\\/]apps[\\/]mobile[\\/]src[\\/]/;

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        "babel-preset-expo",
        {
          unstable_transformImportMeta: true,
          "react-compiler": {
            sources: (filename) => REACT_COMPILER_SOURCES.test(filename),
          },
        },
      ],
    ],
  };
};
