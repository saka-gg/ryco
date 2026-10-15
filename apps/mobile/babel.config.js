// React Compiler (enabled by `experiments.reactCompiler` in app.config.ts) runs
// only on these app directories for now: the shared components, the launch list
// and the thread surfaces that re-render while a turn streams. Functions the
// compiler cannot model, such as try/finally in a component (see
// src/lib/runWhileBusy.ts), are left uncompiled, and reactCompilerCoverage.test.ts
// keeps the hot thread components compiling. Widen the set one directory at a
// time, with an on-device profile, rather than all at once.
const REACT_COMPILER_SOURCES =
  /[\\/]apps[\\/]mobile[\\/]src[\\/](components|features[\\/](home|inbox|projects|threads))[\\/]/;

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
