"use server";

import { createClient } from "@/lib/supabase/server";
import { ACTION_ERROR_CODES, actionFailure, actionSuccess } from "@/lib/action-result";
import {
  findDuplicateContactFields,
  fromContactRecord,
  getPageCount,
  getPaginationOffset,
  toContactRecord,
  validateContactEmail,
  validateContactStatus,
  validatePhoneNumber,
} from "@/lib/contact-utils";

const contactWriteRoles = ["ADMIN", "MANAGER"];
const contactDeleteRoles = ["ADMIN"];
const duplicateCheckBatchSize = 1000;

async function resolveContactContext(client) {
  const { data: authData, error: authError } = await client.auth.getUser();

  if (authError) {
    return actionFailure(
      "Could not verify your sign-in. Please sign in again.",
      ACTION_ERROR_CODES.AUTH_REQUIRED
    );
  }
  if (!authData.user) {
    return actionFailure(
      "You must be signed in to access contacts.",
      ACTION_ERROR_CODES.AUTH_REQUIRED
    );
  }

  const { data: memberships, error: membershipError } = await client
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", authData.user.id);

  if (membershipError) {
    console.error("contacts: could not load organization membership", membershipError);
    return actionFailure("Could not load your organization. Please try again.");
  }
  if (!memberships?.length) {
    return actionFailure("Your account is not a member of an organization.");
  }
  if (memberships.length > 1) {
    return actionFailure(
      "Your account belongs to multiple organizations. Select an organization before managing contacts.",
      ACTION_ERROR_CODES.VALIDATION
    );
  }

  return {
    ok: true,
    data: {
      user: authData.user,
      organizationId: memberships[0].organization_id,
      role: memberships[0].role,
    },
  };
}

function requireContactRole(role, allowedRoles) {
  if (!allowedRoles.includes(role)) {
    return actionFailure(
      "You do not have permission to perform this contact action.",
      ACTION_ERROR_CODES.PERMISSION_DENIED
    );
  }
  return null;
}

/**
 * Validates the parts of a contact the client can change.
 * Returns a failure result, or null when the input is acceptable.
 */
function validateContactInput(changes, { requireFirstName = false } = {}) {
  const phoneResult = validatePhoneNumber(changes.phone);
  if (!phoneResult.valid) {
    return actionFailure(phoneResult.error, ACTION_ERROR_CODES.VALIDATION);
  }

  const emailResult = validateContactEmail(changes.email);
  if (!emailResult.valid) {
    return actionFailure(emailResult.error, ACTION_ERROR_CODES.VALIDATION);
  }

  if (requireFirstName || Object.hasOwn(changes, "firstName")) {
    if (!changes.firstName?.trim()) {
      return actionFailure(
        requireFirstName
          ? "A first name is required to create a contact."
          : "A contact's first name cannot be empty.",
        ACTION_ERROR_CODES.VALIDATION
      );
    }
  }

  if (Object.hasOwn(changes, "status") && changes.status !== undefined) {
    const statusResult = validateContactStatus(changes.status);
    if (!statusResult.valid) {
      return actionFailure(statusResult.error, ACTION_ERROR_CODES.VALIDATION);
    }
  }

  return null;
}

async function findOrganizationDuplicates(client, organizationId, contact, ignoredContactId) {
  const hasEmail = typeof contact.email === "string" && contact.email.trim();
  const hasPhone = typeof contact.phone === "string" && contact.phone.trim();

  if (!hasEmail && !hasPhone) return [];

  const existingContacts = [];
  let offset = 0;
  let totalCount = 0;

  do {
    let query = client
      .from("contacts")
      .select("id, email, phone", { count: "exact" })
      .eq("organization_id", organizationId)
      .order("id", { ascending: true });

    if (ignoredContactId != null) query = query.neq("id", ignoredContactId);

    const { data, count, error } = await query.range(
      offset,
      offset + duplicateCheckBatchSize - 1
    );
    if (error) {
      throw new Error(`Could not check for duplicate contacts: ${error.message}`);
    }

    existingContacts.push(...(data ?? []));
    totalCount = count ?? 0;
    offset += data?.length ?? 0;
  } while (offset < totalCount && offset > 0);

  return findDuplicateContactFields(contact, existingContacts, ignoredContactId);
}

function duplicateFailure(fields) {
  if (!fields.length) return null;

  const labels = fields.map((field) => (field === "email" ? "email address" : "phone number"));
  return actionFailure(
    `A contact with this ${labels.join(" and ")} already exists in your organization.`,
    ACTION_ERROR_CODES.CONFLICT
  );
}

export async function listContacts({ page = 1, pageSize = 20, status } = {}) {
  const client = await createClient();
  const context = await resolveContactContext(client);
  if (!context.ok) return context;

  const { organizationId, role } = context.data;
  const requestedPage = Number(page);
  const requestedPageSize = Number(pageSize);
  const safePage = Number.isFinite(requestedPage)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(requestedPage)))
    : 1;
  const safePageSize = Number.isFinite(requestedPageSize)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(requestedPageSize)))
    : 1;
  const offset = getPaginationOffset(safePage, safePageSize);

  let query = client
    .from("contacts")
    .select("*", { count: "exact" })
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true });

  if (status) query = query.eq("status", status);

  const { data, count, error } = await query.range(offset, offset + safePageSize - 1);
  if (error) {
    console.error("contacts: could not load contacts", error);
    return actionFailure("Could not load contacts. Please try again.");
  }

  return actionSuccess({
    contacts: (data ?? []).map(fromContactRecord),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      offset,
      totalCount: count ?? 0,
      pageCount: getPageCount(count ?? 0, safePageSize),
    },
    permissions: {
      canCreate: contactWriteRoles.includes(role),
      canUpdate: contactWriteRoles.includes(role),
      canDelete: contactDeleteRoles.includes(role),
    },
  });
}

export async function createContact(contact) {
  const client = await createClient();
  const context = await resolveContactContext(client);
  if (!context.ok) return context;

  const roleFailure = requireContactRole(context.data.role, contactWriteRoles);
  if (roleFailure) return roleFailure;

  const inputFailure = validateContactInput(contact, { requireFirstName: true });
  if (inputFailure) return inputFailure;

  let duplicateFields;
  try {
    duplicateFields = await findOrganizationDuplicates(
      client,
      context.data.organizationId,
      contact
    );
  } catch (error) {
    console.error("contacts: could not check for duplicate contacts", error);
    return actionFailure("Could not check for duplicate contacts. Please try again.");
  }

  const duplicate = duplicateFailure(duplicateFields);
  if (duplicate) return duplicate;

  const { data, error } = await client
    .from("contacts")
    .insert({
      ...toContactRecord(contact),
      organization_id: context.data.organizationId,
      created_by: context.data.user.id,
    })
    .select("*")
    .single();

  if (error) {
    console.error("contacts: could not create contact", error);
    return actionFailure("Could not create the contact. Please try again.");
  }
  return actionSuccess(fromContactRecord(data));
}

export async function updateContact(contactId, changes) {
  const client = await createClient();
  const context = await resolveContactContext(client);
  if (!context.ok) return context;

  const roleFailure = requireContactRole(context.data.role, contactWriteRoles);
  if (roleFailure) return roleFailure;

  const inputFailure = validateContactInput(changes);
  if (inputFailure) return inputFailure;

  const { data: existingContact, error: lookupError } = await client
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("organization_id", context.data.organizationId)
    .maybeSingle();

  if (lookupError) {
    console.error("contacts: could not look up the contact to update", lookupError);
    return actionFailure("Could not find the contact to update. Please try again.");
  }
  if (!existingContact) {
    return actionFailure(
      "That contact was not found in your organization.",
      ACTION_ERROR_CODES.NOT_FOUND
    );
  }

  let duplicateFields;
  try {
    duplicateFields = await findOrganizationDuplicates(
      client,
      context.data.organizationId,
      changes,
      contactId
    );
  } catch (error) {
    console.error("contacts: could not check for duplicate contacts", error);
    return actionFailure("Could not check for duplicate contacts. Please try again.");
  }

  const duplicate = duplicateFailure(duplicateFields);
  if (duplicate) return duplicate;

  const contactChanges = toContactRecord(changes);
  if (!Object.keys(contactChanges).length) {
    return actionFailure(
      "Provide at least one contact field to update.",
      ACTION_ERROR_CODES.VALIDATION
    );
  }

  const { data, error } = await client
    .from("contacts")
    .update({ ...contactChanges, updated_at: new Date().toISOString() })
    .eq("id", contactId)
    .eq("organization_id", context.data.organizationId)
    .select("*")
    .single();

  if (error) {
    console.error("contacts: could not update contact", error);
    return actionFailure("Could not update the contact. Please try again.");
  }
  return actionSuccess(fromContactRecord(data));
}

export async function deleteContact(contactId) {
  const client = await createClient();
  const context = await resolveContactContext(client);
  if (!context.ok) return context;

  const roleFailure = requireContactRole(context.data.role, contactDeleteRoles);
  if (roleFailure) return roleFailure;

  const { data, error } = await client
    .from("contacts")
    .delete()
    .eq("id", contactId)
    .eq("organization_id", context.data.organizationId)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("contacts: could not delete contact", error);
    return actionFailure("Could not delete the contact. Please try again.");
  }
  if (!data) {
    return actionFailure(
      "That contact was not found in your organization.",
      ACTION_ERROR_CODES.NOT_FOUND
    );
  }

  return actionSuccess(data.id);
}
