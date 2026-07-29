export const clientEnvironment = {
  get isDevelopment(): boolean {
    return import.meta.env.DEV;
  },
};
