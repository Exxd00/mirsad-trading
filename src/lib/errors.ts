export class AppError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}
export function fail(code:string,status:number,message:string):never {throw new AppError(code,status,message);}
