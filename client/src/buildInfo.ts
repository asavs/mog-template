export type BuildInfo = {
  commit: string;
  mode: string;
};

export const buildInfo: BuildInfo = {
  commit: __BUILD_COMMIT__,
  mode: import.meta.env.MODE,
};
