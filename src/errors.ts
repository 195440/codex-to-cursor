export class ProxyError extends Error {
  statusCode: number;
  type: string;
  code: string;
  param?: string;

  constructor(
    statusCode: number,
    message: string,
    options: {
      type?: string;
      code?: string;
      param?: string;
    } = {},
  ) {
    super(message);
    this.name = "ProxyError";
    this.statusCode = statusCode;
    this.type = options.type ?? "invalid_request_error";
    this.code = options.code ?? "invalid_request";
    this.param = options.param;
  }
}

export function errorPayload(error: ProxyError): {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
  };
} {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: error.param ?? null,
      code: error.code,
    },
  };
}

export function invalidField(param: string, message: string): ProxyError {
  return new ProxyError(400, message, {
    code: "invalid_field",
    param,
  });
}

export function unsupportedFeature(param: string, message: string): ProxyError {
  return new ProxyError(400, message, {
    code: "unsupported_feature",
    param,
  });
}
