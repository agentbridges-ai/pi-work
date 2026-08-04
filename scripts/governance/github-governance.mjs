#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const policy = JSON.parse(readFileSync(join(root, ".governance/github-policy.json"), "utf8"));
const repository = policy.repository;
const [org] = repository.split("/");
const apply = process.argv.includes("--apply");
const retireLegacy = process.argv.includes("--retire-legacy");
const strict = process.argv.includes("--strict");

function gh(method, endpoint, body) {
  const args = ["api", endpoint];
  if (method !== "GET") args.push("--method", method);
  if (body !== undefined) args.push("--input", "-");
  const result = spawnSync("gh", args, {
    cwd: root,
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`${method} ${endpoint}: ${result.stderr || result.stdout}`);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function teamRule(teamId, approvals, filePatterns) {
  return {
    type: "required_reviewers",
    parameters: {
      required_approving_review_count: approvals,
      reviewer_teams: [teamId],
      file_patterns: filePatterns,
    },
  };
}

function mainRuleset(coreId, leadsId) {
  return {
    name: "Piwork main governance",
    target: "branch",
    enforcement: "active",
    bypass_actors: [{ actor_id: leadsId, actor_type: "Team", bypass_mode: "pull_request" }],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "required_linear_history" },
      { type: "required_signatures" },
      {
        type: "pull_request",
        parameters: {
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: true,
          require_last_push_approval: true,
          required_approving_review_count: policy.ordinaryApprovals,
          required_review_thread_resolution: true,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: policy.requiredChecks.map((context) => ({
            context,
            integration_id: -1,
          })),
        },
      },
      teamRule(coreId, policy.ordinaryApprovals, ["**"]),
    ],
  };
}

function highRiskRuleset(coreId, leadsId) {
  return {
    name: "Piwork high-risk review",
    target: "branch",
    enforcement: "active",
    bypass_actors: [{ actor_id: leadsId, actor_type: "Team", bypass_mode: "pull_request" }],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [teamRule(coreId, policy.highRiskApprovals, policy.highRiskPaths)],
  };
}

function releaseTagRuleset(leadsId, releaseAutomationId) {
  return {
    name: "Piwork release tags",
    target: "tag",
    enforcement: "active",
    bypass_actors: [
      { actor_id: leadsId, actor_type: "Team", bypass_mode: "always" },
      { actor_id: releaseAutomationId, actor_type: "Integration", bypass_mode: "always" },
    ],
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "creation" }, { type: "deletion" }, { type: "non_fast_forward" }],
  };
}

function releaseAutomationId() {
  const app = gh("GET", `/apps/${policy.releaseAutomation}`);
  if (!Number.isInteger(app?.id))
    throw new Error("Release automation integration ID is unavailable");
  return app.id;
}

function desiredSecurityAnalysis() {
  return {
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
    secret_scanning_non_provider_patterns: { status: "enabled" },
    secret_scanning_validity_checks: { status: "enabled" },
  };
}

function configureProductionEnvironment() {
  const endpoint = `/repos/${repository}/environments/${policy.productionEnvironment}`;
  applyOrReport(
    `configure ${policy.productionEnvironment} environment for ${policy.productionBranch}`,
    () =>
      gh("PUT", endpoint, {
        wait_timer: 0,
        reviewers: [],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      }),
  );
  if (!apply) return;
  const policies = gh("GET", `${endpoint}/deployment-branch-policies`);
  const branchPolicies = Array.isArray(policies) ? policies : policies?.branch_policies || [];
  if (!branchPolicies.some((item) => item.name === policy.productionBranch)) {
    gh("POST", `${endpoint}/deployment-branch-policies`, { name: policy.productionBranch });
  }
}

function applyOrReport(label, action) {
  if (!apply) {
    console.log(`[github-governance] dry-run: ${label}`);
    return null;
  }
  return action();
}

function readbackDrift() {
  const drift = [];
  const repositorySettings = gh("GET", `/repos/${repository}`);
  if (
    !repositorySettings.allow_squash_merge ||
    repositorySettings.allow_merge_commit ||
    repositorySettings.allow_rebase_merge
  ) {
    drift.push("repository merge settings are not squash-only");
  }
  if (!repositorySettings.delete_branch_on_merge)
    drift.push("merged branches are not configured for automatic deletion");
  const security = repositorySettings.security_and_analysis || {};
  for (const [key, label] of [
    ["secret_scanning", "Secret Scanning"],
    ["secret_scanning_push_protection", "Secret Scanning Push Protection"],
    ["secret_scanning_non_provider_patterns", "non-provider Secret Scanning patterns"],
    ["secret_scanning_validity_checks", "Secret Scanning validity checks"],
    ["dependabot_security_updates", "Dependabot Security Updates"],
  ]) {
    if (security[key]?.status !== "enabled") drift.push(`${label} is not enabled`);
  }
  try {
    const pvr = gh("GET", `/repos/${repository}/private-vulnerability-reporting`);
    if (pvr?.enabled !== true) drift.push("Private Vulnerability Reporting is not enabled");
  } catch {
    drift.push("Private Vulnerability Reporting readback is unavailable");
  }
  try {
    const workflowPermissions = gh("GET", `/repos/${repository}/actions/permissions/workflow`);
    if (
      workflowPermissions?.default_workflow_permissions !== policy.workflowPermissions.default ||
      workflowPermissions?.can_approve_pull_request_reviews !==
        policy.workflowPermissions.canApprovePullRequestReviews
    ) {
      drift.push("workflow default permissions are not read-only/non-approving");
    }
  } catch {
    drift.push("workflow permission readback is unavailable");
  }
  try {
    const environment = gh(
      "GET",
      `/repos/${repository}/environments/${policy.productionEnvironment}`,
    );
    const branchPolicy = environment?.deployment_branch_policy;
    if (!branchPolicy?.custom_branch_policies || branchPolicy.protected_branches) {
      drift.push(`${policy.productionEnvironment} environment branch policy is not custom-only`);
    }
    const policiesResponse = gh(
      "GET",
      `/repos/${repository}/environments/${policy.productionEnvironment}/deployment-branch-policies`,
    );
    const policies = Array.isArray(policiesResponse)
      ? policiesResponse
      : policiesResponse?.branch_policies || [];
    if (
      policies.length !== 1 ||
      policies[0]?.name !== policy.productionBranch ||
      environment?.protection_rules?.length ||
      environment?.wait_timer !== 0
    ) {
      drift.push(`${policy.productionEnvironment} environment is not main-only with no approvals`);
    }
  } catch {
    drift.push(`${policy.productionEnvironment} environment is missing or unreadable`);
  }

  for (const slug of [policy.coreTeam, policy.leadsTeam]) {
    try {
      gh("GET", `/orgs/${org}/teams/${slug}`);
    } catch {
      drift.push(`missing GitHub Team ${slug}`);
    }
  }

  const rulesets = gh("GET", `/repos/${repository}/rulesets?includes_parents=false`);
  for (const name of ["Piwork main governance", "Piwork high-risk review", "Piwork release tags"]) {
    const ruleset = rulesets.find((item) => item.name === name);
    if (!ruleset || ruleset.enforcement !== "active")
      drift.push(`ruleset ${name} is missing or inactive`);
  }
  const main = rulesets.find((item) => item.name === "Piwork main governance");
  const contexts =
    main?.rules
      ?.find((rule) => rule.type === "required_status_checks")
      ?.parameters?.required_status_checks?.map((check) => check.context) || [];
  for (const requiredCheck of policy.requiredChecks) {
    if (!contexts.includes(requiredCheck))
      drift.push(`main ruleset is missing required check ${requiredCheck}`);
  }
  const tag = rulesets.find((item) => item.name === "Piwork release tags");
  try {
    const automationId = releaseAutomationId();
    const bypass = tag?.bypass_actors || [];
    if (
      !bypass.some((actor) => actor.actor_type === "Integration" && actor.actor_id === automationId)
    ) {
      drift.push("release tag ruleset does not allow GitHub Actions automation");
    }
  } catch {
    drift.push("GitHub Actions integration readback is unavailable");
  }
  return drift;
}

function reportReadback() {
  try {
    const drift = readbackDrift();
    if (drift.length) {
      console.warn(
        `[github-governance] readback drift:\n${drift.map((item) => `- ${item}`).join("\n")}`,
      );
      if (strict) throw new Error("GitHub governance readback drift detected");
    } else {
      console.log("[github-governance] readback matches the policy baseline");
    }
  } catch (error) {
    if (strict) throw error;
    console.warn(
      `[github-governance] readback unavailable in non-strict mode: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

try {
  const teams = {};
  for (const [slug, description, permission] of [
    [policy.coreTeam, "Piwork Core Team", "push"],
    [policy.leadsTeam, "Piwork Leads and governance bypass", "maintain"],
  ]) {
    let team;
    try {
      team = gh("GET", `/orgs/${org}/teams/${slug}`);
    } catch {
      team = applyOrReport(`create team ${slug}`, () =>
        gh("POST", `/orgs/${org}/teams`, {
          name: slug,
          description,
          privacy: "closed",
          maintainers: [policy.leader],
        }),
      );
    }
    if (!team) continue;
    teams[slug] = team;
    applyOrReport(`grant ${permission} on ${repository} to ${slug}`, () =>
      gh("PUT", `/orgs/${org}/teams/${slug}/repos/${repository}`, { permission }),
    );
    applyOrReport(`ensure ${policy.leader} is maintainer of ${slug}`, () =>
      gh("PUT", `/orgs/${org}/teams/${slug}/memberships/${policy.leader}`, { role: "maintainer" }),
    );
  }

  if (!teams[policy.coreTeam] || !teams[policy.leadsTeam]) {
    if (!apply) {
      console.log("[github-governance] apply would create/resolve both teams before rulesets");
      reportReadback();
      process.exit(0);
    }
    throw new Error("Team IDs are unavailable; rerun after Teams are created");
  }

  applyOrReport("enable squash-only repository settings", () =>
    gh("PATCH", `/repos/${repository}`, {
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      delete_branch_on_merge: true,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "BLANK",
      use_squash_pr_title_as_default: true,
      security_and_analysis: desiredSecurityAnalysis(),
    }),
  );
  applyOrReport("enable Private Vulnerability Reporting", () =>
    gh("PUT", `/repos/${repository}/private-vulnerability-reporting`),
  );
  applyOrReport("enable Dependabot vulnerability alerts", () =>
    gh("PUT", `/repos/${repository}/vulnerability-alerts`),
  );
  applyOrReport("enable Dependabot security updates", () =>
    gh("PUT", `/repos/${repository}/automated-security-fixes`),
  );
  applyOrReport("set read-only workflow permissions", () =>
    gh("PUT", `/repos/${repository}/actions/permissions/workflow`, {
      default_workflow_permissions: policy.workflowPermissions.default,
      can_approve_pull_request_reviews: policy.workflowPermissions.canApprovePullRequestReviews,
    }),
  );
  configureProductionEnvironment();

  const rulesets = gh("GET", `/repos/${repository}/rulesets?includes_parents=false`);
  const automationId = releaseAutomationId();
  for (const desired of [
    mainRuleset(teams[policy.coreTeam].id, teams[policy.leadsTeam].id),
    highRiskRuleset(teams[policy.coreTeam].id, teams[policy.leadsTeam].id),
    releaseTagRuleset(teams[policy.leadsTeam].id, automationId),
  ]) {
    const existing = rulesets.find((item) => item.name === desired.name);
    applyOrReport(`${existing ? "update" : "create"} ruleset ${desired.name}`, () =>
      existing
        ? gh("PUT", `/repos/${repository}/rulesets/${existing.id}`, desired)
        : gh("POST", `/repos/${repository}/rulesets`, desired),
    );
  }

  if (retireLegacy) {
    applyOrReport("retire legacy branch protection after ruleset verification", () =>
      gh("DELETE", `/repos/${repository}/branches/main/protection`),
    );
  } else {
    console.log(
      "[github-governance] legacy branch protection remains until active rulesets are read back and verified",
    );
  }

  if (!apply) {
    reportReadback();
    console.log(`[github-governance] dry-run complete for ${repository}`);
  } else {
    console.log(`[github-governance] applied governance configuration to ${repository}`);
  }
} catch (error) {
  console.error(`[github-governance] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
