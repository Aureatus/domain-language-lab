export function asError(value:unknown):Error {
  return value instanceof Error ? value : new Error(String(value), {cause:value});
}

export function errorMessage(value:unknown):string {
  return asError(value).message;
}

export function httpErrorStatus(value:unknown):number|undefined {
  return value instanceof Error&&'httpStatus' in value&&typeof value.httpStatus==='number' ? value.httpStatus : undefined;
}
