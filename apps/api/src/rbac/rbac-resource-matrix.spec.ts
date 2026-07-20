import { OrganizationRole } from "@automation/shared-types";
import { REQUIRED_ROLES_KEY } from "./roles.decorator";
import { ExecutionsController, WorkflowExecutionsController } from "../executions/executions.controller";
import { WorkflowsController } from "../workflows/workflows.controller";
import { WorkflowTemplatesController } from "../workflow-templates/workflow-templates.controller";
import { NotificationsController, NotificationRulesController } from "../notifications/notifications.controller";
import { TriggersController } from "../triggers/triggers.controller";
import { WorkflowTestRunsController } from "../workflow-test-runs/workflow-test-runs.controller";

type Entry = [object, string, OrganizationRole | undefined];

const matrix: Entry[] = [
  [WorkflowsController.prototype, "list", undefined], [WorkflowsController.prototype, "detail", undefined],
  [WorkflowsController.prototype, "create", OrganizationRole.Editor], [WorkflowsController.prototype, "createVersion", OrganizationRole.Editor], [WorkflowsController.prototype, "activateVersion", OrganizationRole.Editor],
  [ExecutionsController.prototype, "list", OrganizationRole.Viewer], [ExecutionsController.prototype, "getDetail", OrganizationRole.Viewer], [ExecutionsController.prototype, "timeline", OrganizationRole.Viewer], [ExecutionsController.prototype, "stepDetail", OrganizationRole.Viewer],
  [ExecutionsController.prototype, "retry", OrganizationRole.Editor], [ExecutionsController.prototype, "replay", OrganizationRole.Editor], [ExecutionsController.prototype, "cancel", OrganizationRole.Editor],
  [WorkflowExecutionsController.prototype, "createManual", OrganizationRole.Editor],
  [WorkflowTemplatesController.prototype, "list", undefined], [WorkflowTemplatesController.prototype, "create", OrganizationRole.Editor], [WorkflowTemplatesController.prototype, "instantiate", OrganizationRole.Editor], [WorkflowTemplatesController.prototype, "publish", OrganizationRole.Admin], [WorkflowTemplatesController.prototype, "archive", OrganizationRole.Admin],
  [TriggersController.prototype, "list", undefined], [TriggersController.prototype, "createWebhookTrigger", OrganizationRole.Editor], [TriggersController.prototype, "createEvent", OrganizationRole.Editor], [TriggersController.prototype, "delete", OrganizationRole.Editor],
  [NotificationRulesController.prototype, "list", undefined], [NotificationRulesController.prototype, "create", OrganizationRole.Editor], [NotificationRulesController.prototype, "update", OrganizationRole.Editor], [NotificationRulesController.prototype, "delete", OrganizationRole.Editor],
  [NotificationsController.prototype, "list", undefined], [NotificationsController.prototype, "detail", undefined], [NotificationsController.prototype, "retry", OrganizationRole.Admin],
  [WorkflowTestRunsController.prototype, "list", undefined], [WorkflowTestRunsController.prototype, "detail", undefined], [WorkflowTestRunsController.prototype, "create", OrganizationRole.Editor], [WorkflowTestRunsController.prototype, "rerun", OrganizationRole.Editor]
];

describe("RC1 productive resource RBAC matrix", () => {
  it.each(matrix)("locks %s.%s at %s", (prototype, method, minimum) => {
    const roles = Reflect.getMetadata(REQUIRED_ROLES_KEY, (prototype as any)[method]);
    expect(roles).toEqual(minimum ? [minimum] : undefined);
    const allowed = [OrganizationRole.Viewer, OrganizationRole.Editor, OrganizationRole.Admin, OrganizationRole.Owner].filter((role) => !minimum || rank(role) >= rank(minimum));
    expect(allowed.length).toBe(minimum === OrganizationRole.Admin ? 2 : minimum === OrganizationRole.Editor ? 3 : 4);
  });
});

function rank(role: OrganizationRole) { return [OrganizationRole.Viewer, OrganizationRole.Editor, OrganizationRole.Admin, OrganizationRole.Owner].indexOf(role); }
