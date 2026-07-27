export const clientEnvironment = {
  get isDevelopment(): boolean {
    return import.meta.env.DEV;
  },
  get onlyOfficeHostUrlTemplate(): string {
    return import.meta.env.VITE_PIWORK_ONLYOFFICE_HOST_URL_TEMPLATE?.trim() || "";
  },
};
