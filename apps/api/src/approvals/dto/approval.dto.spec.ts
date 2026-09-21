import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { ListApprovalsQueryDto } from "./approval.dto";

describe("ListApprovalsQueryDto", () => {
  it("accepts valid numeric pagination from an HTTP query string", () => {
    const query = plainToInstance(ListApprovalsQueryDto, { status: "PENDING", page: "2", pageSize: "20" });
    expect(validateSync(query)).toHaveLength(0);
    expect(query.page).toBe(2);
    expect(query.pageSize).toBe(20);
  });

  it("rejects invalid page values", () => {
    const query = plainToInstance(ListApprovalsQueryDto, { page: "invalid", pageSize: "101" });
    expect(validateSync(query)).toHaveLength(2);
  });
});
