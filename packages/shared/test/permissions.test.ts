import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  TEAM_ROLES,
  WORKSPACE_ROLES,
  allowedContentTransitions,
  can,
  canDecideApproval,
  checkContentTransition,
  checkMemberRemoval,
  checkRoleChange,
  invitableRoles,
  permissionsFor,
  type Permission,
} from '../src/index';

describe('permission matrix', () => {
  it('grants owners every permission', () => {
    expect(permissionsFor('OWNER')).toEqual(ALL_PERMISSIONS);
  });

  it('keeps billing changes and workspace deletion with owners only', () => {
    for (const permission of ['billing.manage', 'workspace.delete'] as Permission[]) {
      expect(can('OWNER', permission)).toBe(true);
      expect(can('ADMIN', permission)).toBe(false);
      expect(can('MEMBER', permission)).toBe(false);
    }
  });

  it('lets admins (but not members) manage projects, members, integrations and approvals', () => {
    for (const permission of [
      'project.delete',
      'members.manage',
      'integration.manage',
      'content.approve',
    ] as Permission[]) {
      expect(can('ADMIN', permission)).toBe(true);
      expect(can('MEMBER', permission)).toBe(false);
    }
  });

  it('lets members do day-to-day project work', () => {
    for (const permission of [
      'project.read',
      'audit.run',
      'prompt.manage',
      'content.edit',
      'report.create',
    ] as Permission[]) {
      expect(can('MEMBER', permission)).toBe(true);
    }
  });

  it('denies everything without a role', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(can(null, permission)).toBe(false);
      expect(can(undefined, permission)).toBe(false);
    }
  });

  it('is monotonic: a higher role never has fewer permissions', () => {
    const member = new Set(permissionsFor('MEMBER'));
    const admin = new Set(permissionsFor('ADMIN'));
    for (const p of member) expect(admin.has(p)).toBe(true);
    for (const p of admin) expect(can('OWNER', p)).toBe(true);
    // CLIENT sits outside the team hierarchy (it can decide approvals but cannot edit).
    expect(TEAM_ROLES).toEqual(['OWNER', 'ADMIN', 'MEMBER']);
    expect(WORKSPACE_ROLES).toEqual(['OWNER', 'ADMIN', 'MEMBER', 'CLIENT']);
  });
});

describe('role changes', () => {
  const base = { actorIsTarget: false, ownerCount: 2 } as const;

  it('prevents members from changing roles', () => {
    expect(
      checkRoleChange({ ...base, actorRole: 'MEMBER', targetCurrentRole: 'MEMBER', newRole: 'ADMIN' }),
    ).toBe('INSUFFICIENT_ROLE');
  });

  it('lets admins switch members and admins but not touch owners', () => {
    expect(
      checkRoleChange({ ...base, actorRole: 'ADMIN', targetCurrentRole: 'MEMBER', newRole: 'ADMIN' }),
    ).toBeNull();
    expect(
      checkRoleChange({ ...base, actorRole: 'ADMIN', targetCurrentRole: 'OWNER', newRole: 'ADMIN' }),
    ).toBe('CANNOT_MANAGE_OWNER');
    expect(
      checkRoleChange({ ...base, actorRole: 'ADMIN', targetCurrentRole: 'MEMBER', newRole: 'OWNER' }),
    ).toBe('CANNOT_GRANT_OWNER');
  });

  it('lets owners grant ownership but never demote the last owner or themselves', () => {
    expect(
      checkRoleChange({ ...base, actorRole: 'OWNER', targetCurrentRole: 'ADMIN', newRole: 'OWNER' }),
    ).toBeNull();
    expect(
      checkRoleChange({
        actorRole: 'OWNER',
        actorIsTarget: false,
        targetCurrentRole: 'OWNER',
        newRole: 'MEMBER',
        ownerCount: 1,
      }),
    ).toBe('LAST_OWNER');
    expect(
      checkRoleChange({
        actorRole: 'OWNER',
        actorIsTarget: true,
        targetCurrentRole: 'OWNER',
        newRole: 'MEMBER',
        ownerCount: 3,
      }),
    ).toBe('SELF_CHANGE');
  });

  it('applies removal rules', () => {
    expect(
      checkMemberRemoval({ actorRole: 'MEMBER', actorIsTarget: true, targetRole: 'MEMBER', ownerCount: 1 }),
    ).toBeNull();
    expect(
      checkMemberRemoval({ actorRole: 'MEMBER', actorIsTarget: false, targetRole: 'MEMBER', ownerCount: 1 }),
    ).toBe('INSUFFICIENT_ROLE');
    expect(
      checkMemberRemoval({ actorRole: 'ADMIN', actorIsTarget: false, targetRole: 'OWNER', ownerCount: 2 }),
    ).toBe('CANNOT_MANAGE_OWNER');
    expect(
      checkMemberRemoval({ actorRole: 'OWNER', actorIsTarget: true, targetRole: 'OWNER', ownerCount: 1 }),
    ).toBe('LAST_OWNER');
    expect(
      checkMemberRemoval({ actorRole: 'OWNER', actorIsTarget: false, targetRole: 'OWNER', ownerCount: 2 }),
    ).toBeNull();
  });

  it('limits which roles can be invited', () => {
    expect(invitableRoles('OWNER')).toEqual(['OWNER', 'ADMIN', 'MEMBER', 'CLIENT']);
    expect(invitableRoles('ADMIN')).toEqual(['ADMIN', 'MEMBER', 'CLIENT']);
    expect(invitableRoles('CLIENT')).toEqual([]);
    expect(invitableRoles('MEMBER')).toEqual([]);
  });
});

describe('content approval workflow', () => {
  it('requires an approver to approve or publish', () => {
    expect(checkContentTransition('DRAFT', 'IN_REVIEW', 'MEMBER')).toBeNull();
    expect(checkContentTransition('IN_REVIEW', 'APPROVED', 'MEMBER')).toBe('NOT_APPROVER');
    expect(checkContentTransition('IN_REVIEW', 'APPROVED', 'ADMIN')).toBeNull();
    expect(checkContentTransition('APPROVED', 'PUBLISHED', 'MEMBER')).toBe('NOT_APPROVER');
  });

  it('rejects skipping review', () => {
    expect(checkContentTransition('DRAFT', 'APPROVED', 'OWNER')).toBe('INVALID_TRANSITION');
    expect(checkContentTransition('DRAFT', 'PUBLISHED', 'OWNER')).toBe('INVALID_TRANSITION');
    expect(checkContentTransition('DRAFT', 'DRAFT', 'OWNER')).toBe('SAME_STATUS');
  });

  it('lists only the transitions a role may perform', () => {
    expect(allowedContentTransitions('IN_REVIEW', 'MEMBER')).toEqual(['DRAFT', 'ARCHIVED']);
    expect(allowedContentTransitions('IN_REVIEW', 'OWNER')).toEqual(['DRAFT', 'APPROVED', 'ARCHIVED']);
  });

  it('lets clients approve or send back content in review, and nothing else', () => {
    expect(allowedContentTransitions('IN_REVIEW', 'CLIENT')).toEqual(['DRAFT', 'APPROVED']);
    expect(allowedContentTransitions('DRAFT', 'CLIENT')).toEqual([]);
    expect(checkContentTransition('APPROVED', 'PUBLISHED', 'CLIENT')).toBe('NO_PERMISSION');
    expect(checkContentTransition('DRAFT', 'APPROVED', 'CLIENT')).toBe('INVALID_TRANSITION');
  });

  it('leaves approval to the client in agency-managed workspaces unless delegated', () => {
    const agency = { via: 'AGENCY' as const, approvalsDelegated: false };
    expect(checkContentTransition('IN_REVIEW', 'APPROVED', 'ADMIN', agency)).toBe(
      'CUSTOMER_APPROVAL_REQUIRED',
    );
    expect(
      checkContentTransition('IN_REVIEW', 'APPROVED', 'ADMIN', { ...agency, approvalsDelegated: true }),
    ).toBeNull();
    // The agency can still move work forward and confirm publication once the client approved.
    expect(checkContentTransition('DRAFT', 'IN_REVIEW', 'MEMBER', agency)).toBeNull();
    expect(checkContentTransition('APPROVED', 'PUBLISHED', 'ADMIN', agency)).toBeNull();
  });
});

describe('client role and approvals', () => {
  it('gives clients read access, approvals and the brief, but no editing or paid actions', () => {
    for (const permission of [
      'project.read',
      'approval.decide',
      'approval.read',
      'brief.edit',
      'task.read',
    ] as Permission[])
      expect(can('CLIENT', permission)).toBe(true);
    for (const permission of [
      'content.edit',
      'audit.run',
      'visibility.run',
      'report.create',
      'local.manage',
      'members.invite',
      'billing.read',
      'integration.manage',
      'task.manage',
    ] as Permission[])
      expect(can('CLIENT', permission)).toBe(false);
  });

  it('lets team members request approvals but only customers decide them', () => {
    expect(can('MEMBER', 'approval.request')).toBe(true);
    expect(can('MEMBER', 'approval.decide')).toBe(false);
    expect(canDecideApproval({ role: 'OWNER', via: 'DIRECT' })).toBe(true);
    expect(canDecideApproval({ role: 'CLIENT', via: 'DIRECT' })).toBe(true);
    expect(canDecideApproval({ role: 'MEMBER', via: 'DIRECT' })).toBe(false);
  });

  it('lets an agency decide approvals only when the client delegated them', () => {
    expect(canDecideApproval({ role: 'ADMIN', via: 'AGENCY', approvalsDelegated: false })).toBe(false);
    expect(canDecideApproval({ role: 'ADMIN', via: 'AGENCY', approvalsDelegated: true })).toBe(true);
    // Delegation does not lift role limits: agency members still cannot decide.
    expect(canDecideApproval({ role: 'MEMBER', via: 'AGENCY', approvalsDelegated: true })).toBe(false);
  });

  it('keeps publishing approved external changes with owners and admins', () => {
    for (const permission of ['local.publish', 'commerce.publish', 'site.publish'] as Permission[]) {
      expect(can('ADMIN', permission)).toBe(true);
      expect(can('MEMBER', permission)).toBe(false);
      expect(can('CLIENT', permission)).toBe(false);
    }
  });
});
