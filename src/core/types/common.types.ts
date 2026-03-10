export type PaginationQuery = {
  page?: number;
  limit?: number;
};

export type PaginatedResult<T> = {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};
