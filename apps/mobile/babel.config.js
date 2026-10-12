// React Compiler (enabled by `experiments.reactCompiler` in app.config.ts) runs
// only on these app directories for now: they render the launch list, and the
// compiler reports no rules-of-React violations in them (functions it cannot
// model, such as try/finally, are left uncompiled). Widen the set one directory
// at a time, with an on-device profile, rather than all at once.
const REACT_COMPILER_SOURCES =
  /[\\/]apps[\\/]mobile[\\/]src[\\/]features[\\/](home|inbox|projects)[\\/]/;

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
