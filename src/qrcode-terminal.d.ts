declare module "qrcode-terminal" {
  interface QrcodeOptions {
    small?: boolean;
  }
  function generate(
    text: string,
    options?: QrcodeOptions,
    callback?: (output: string) => void,
  ): void;
  function generate(text: string, callback?: (output: string) => void): void;
}
