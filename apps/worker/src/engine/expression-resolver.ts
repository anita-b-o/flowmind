import { Injectable } from "@nestjs/common";
import { ExpressionResolver as SharedExpressionResolver } from "@automation/expression-engine";

@Injectable()
export class ExpressionResolver extends SharedExpressionResolver {}
