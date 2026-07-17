import { BadRequestException } from "@nestjs/common";
import {
  graphAvailableStepKeys,
  validateGraphV2,
  type GraphLike,
  type GraphStepLike
} from "@automation/shared-types";

export { graphAvailableStepKeys };

export function validateWorkflowGraph(steps: GraphStepLike[], graph: GraphLike | undefined) {
  const issues = validateGraphV2(steps, graph);
  const firstError = issues.find((issue) => issue.severity === "error");
  if (firstError) {
    throw new BadRequestException(firstError.message);
  }
}
