declare global {
  namespace Express {
    interface UserContext {
      id: string;
      roles: string[];
    }

    interface Request {
      user?: UserContext;
      rawBody?: string;
    }
  }
}

export {};
