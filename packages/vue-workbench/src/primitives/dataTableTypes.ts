export type WorkbenchDataTableColumn<TRow = unknown> = {
  key: string;
  title?: string;
  width?: string;
  class?: string;
  headerClass?: string;
  cellClass?: string | ((row: TRow, column: WorkbenchDataTableColumn<TRow>) => string);
};
