"use server";

import { createClient } from "@/lib/supabase/server";
import { ACTION_ERROR_CODES, actionFailure, actionSuccess } from "@/lib/action-result";
import { fromContactRecord } from "@/lib/contact-utils";
import {
  fromCampaignRecord,
  getPageCount,
  getPaginationOffset,
  toCampaignRecord,
  toScheduledAtIso,
  validateCampaignChannel,
  validateCampaignName,
  validateCampaignStatus,
} from "@/lib/campaign-utils";

const campaignWriteRoles = ["ADMIN", "MANAGER"];
const campaignDeleteRoles = ["ADMIN"];
const queryBatchSize = 1000;
const campaignInputFields = new Set([
  "name",
  "description",
  "channel",
  "status",
  "scheduledAt",
]);

async function resolveCampaignContext(client) {
  const { data: authData, error: authError } = await client.auth.getUser();

  if (authError) {
    return actionFailure(
      "Could not verify your sign-in. Please sign in again.",
      ACTION_ERROR_CODES.AUTH_REQUIRED
    );
  }
  if (!authData.user) {
    return actionFailure(
      "You must be signed in to access campaigns.",
      ACTION_ERROR_CODES.AUTH_REQUIRED
    );
  }

  const { data: memberships, error: membershipError } = await client
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", authData.user.id);

  if (membershipError) {
    console.error("campaigns: could not load organization membership", membershipError);
    return actionFailure("Could not load your organization. Please try again.");
  }
  if (!memberships?.length) {
    return actionFailure("Your account is not a member of an organization.");
  }
  if (memberships.length > 1) {
    return actionFailure(
      "Your account belongs to multiple organizations. Select an organization before managing campaigns.",
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

function requireCampaignRole(role, allowedRoles) {
  if (!allowedRoles.includes(role)) {
    return actionFailure(
      "You do not have permission to perform this campaign action.",
      ACTION_ERROR_CODES.PERMISSION_DENIED
    );
  }
  return null;
}

/**
 * Validates and normalizes the campaign fields the client may send.
 * Returns { record } on success, or { error } with a user-safe message.
 */
function normalizeCampaignInput(campaign, { partial = false } = {}) {
  if (!campaign || typeof campaign !== "object" || Array.isArray(campaign)) {
    return {
      error: actionFailure(
        "Campaign details must be provided as an object.",
        ACTION_ERROR_CODES.VALIDATION
      ),
    };
  }

  const unsupportedFields = Object.keys(campaign).filter((field) => !campaignInputFields.has(field));
  if (unsupportedFields.length) {
    return {
      error: actionFailure(
        `Unsupported campaign field: ${unsupportedFields.join(", ")}.`,
        ACTION_ERROR_CODES.VALIDATION
      ),
    };
  }

  const normalized = { ...campaign };

  if (!partial || Object.hasOwn(campaign, "name")) {
    const result = validateCampaignName(campaign.name);
    if (!result.valid) {
      return { error: actionFailure(result.error, ACTION_ERROR_CODES.VALIDATION) };
    }
    normalized.name = result.value;
  }

  if (!partial || Object.hasOwn(campaign, "channel")) {
    const result = validateCampaignChannel(campaign.channel);
    if (!result.valid) {
      return { error: actionFailure(result.error, ACTION_ERROR_CODES.VALIDATION) };
    }
  }

  if (Object.hasOwn(campaign, "description")
    && campaign.description !== null
    && typeof campaign.description !== "string") {
    return {
      error: actionFailure(
        "Campaign description must be text or empty.",
        ACTION_ERROR_CODES.VALIDATION
      ),
    };
  }

  if (!partial || Object.hasOwn(campaign, "status")) {
    const status = !partial && campaign.status === undefined
      ? "draft"
      : campaign.status;
    const result = validateCampaignStatus(status);
    if (!result.valid) {
      return { error: actionFailure(result.error, ACTION_ERROR_CODES.VALIDATION) };
    }
    normalized.status = status;
  }

  if (Object.hasOwn(campaign, "scheduledAt")) {
    const result = toScheduledAtIso(campaign.scheduledAt);
    if (!result.valid) {
      return { error: actionFailure(result.error, ACTION_ERROR_CODES.VALIDATION) };
    }
    normalized.scheduledAt = result.value;
  }

  return { record: toCampaignRecord(normalized) };
}

function normalizeRecipientContactIds(contactIds) {
  if (!Array.isArray(contactIds)) {
    return {
      error: actionFailure(
        "Campaign recipient contact IDs must be provided as a list.",
        ACTION_ERROR_CODES.VALIDATION
      ),
    };
  }

  const uniqueIds = [...new Set(contactIds)];
  if (uniqueIds.some((id) => typeof id !== "string" || !id.trim())) {
    return {
      error: actionFailure(
        "Every campaign recipient must have a valid contact ID.",
        ACTION_ERROR_CODES.VALIDATION
      ),
    };
  }

  return { ids: uniqueIds };
}

async function validateOrganizationContacts(client, organizationId, contactIds) {
  if (!contactIds.length) return null;

  const { data, error } = await client
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .in("id", contactIds);

  if (error) {
    console.error("campaigns: could not validate campaign contacts", error);
    return actionFailure("Could not validate the selected contacts. Please try again.");
  }

  const foundIds = new Set((data ?? []).map((contact) => contact.id));
  const missingIds = contactIds.filter((contactId) => !foundIds.has(contactId));
  if (missingIds.length) {
    return actionFailure(
      "One or more selected contacts do not belong to your organization or are unavailable.",
      ACTION_ERROR_CODES.VALIDATION
    );
  }

  return null;
}

async function insertRecipientAssociations(client, organizationId, campaignId, contactIds) {
  if (!contactIds.length) return null;

  const recipientRows = contactIds.map((contactId) => ({
    organization_id: organizationId,
    campaign_id: campaignId,
    contact_id: contactId,
    status: "pending",
  }));

  const { error } = await client.from("campaign_contacts").insert(recipientRows);
  if (error) {
    console.error("campaigns: could not save campaign recipients", error);
    return actionFailure("Could not save the campaign recipients. Please try again.");
  }

  return null;
}

/**
 * Removes the given recipients.
 *
 * Returns { removedIds, missingIds } instead of throwing, because a removal
 * can partially succeed: rows the caller is not allowed to delete are skipped
 * by Row Level Security rather than raising an error. The caller needs the
 * list of rows that really were deleted so it can put them back if the
 * overall update has to be rolled back.
 */
async function removeRecipientAssociations(client, organizationId, campaignId, contactIds) {
  if (!contactIds.length) return { removedIds: [], missingIds: [] };

  const { data, error } = await client
    .from("campaign_contacts")
    .delete()
    .eq("organization_id", organizationId)
    .eq("campaign_id", campaignId)
    .in("contact_id", contactIds)
    .select("contact_id");

  if (error) {
    console.error("campaigns: could not remove campaign recipients", error);
    return {
      removedIds: [],
      missingIds: contactIds,
      error: actionFailure("Could not remove the campaign recipients. Please try again."),
    };
  }

  const removedIds = [...new Set((data ?? []).map((row) => row.contact_id))];
  const missingIds = contactIds.filter((contactId) => !removedIds.includes(contactId));

  return { removedIds, missingIds, error: null };
}

async function fetchCampaignRecipientCounts(client, organizationId, campaignIds) {
  const countsByCampaignId = {};
  if (campaignIds && campaignIds.length === 0) return countsByCampaignId;

  let offset = 0;
  let totalCount = 0;

  do {
    let query = client
      .from("campaign_contacts")
      .select("id, campaign_id", { count: "exact" })
      .eq("organization_id", organizationId)
      .order("id", { ascending: true });

    if (campaignIds) query = query.in("campaign_id", campaignIds);

    const { data, count, error } = await query.range(
      offset,
      offset + queryBatchSize - 1
    );
    if (error) {
      console.error("campaigns: could not load campaign recipient counts", error);
      return actionFailure("Could not load the campaign recipient counts. Please try again.");
    }

    for (const row of data ?? []) {
      countsByCampaignId[row.campaign_id] = (countsByCampaignId[row.campaign_id] ?? 0) + 1;
    }

    totalCount = count ?? 0;
    offset += data?.length ?? 0;
  } while (offset < totalCount && offset > 0);

  return countsByCampaignId;
}

async function listExistingRecipientIds(client, organizationId, campaignId) {
  const contactIds = [];
  let offset = 0;

  while (true) {
    const { data, error } = await client
      .from("campaign_contacts")
      .select("id, contact_id")
      .eq("organization_id", organizationId)
      .eq("campaign_id", campaignId)
      .order("id", { ascending: true })
      .range(offset, offset + queryBatchSize - 1);

    if (error) {
      console.error("campaigns: could not load current campaign recipients", error);
      return actionFailure("Could not load the current campaign recipients. Please try again.");
    }

    contactIds.push(...(data ?? []).map((row) => row.contact_id));
    if (!data || data.length < queryBatchSize) return contactIds;
    offset += data.length;
  }
}

async function restoreCampaignFields(client, organizationId, campaignId, originalCampaign, updatedColumns) {
  if (!updatedColumns.length) return null;

  const restoreValues = Object.fromEntries(
    updatedColumns.map((column) => [column, originalCampaign[column]])
  );
  restoreValues.updated_at = new Date().toISOString();

  const { data, error } = await client
    .from("campaigns")
    .update(restoreValues)
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  if (error) return error.message;
  if (!data) return "Campaign fields could not be restored.";
  return null;
}

async function cleanupAddedRecipients(client, organizationId, campaignId, contactIds) {
  if (!contactIds.length) return null;

  const { data, error } = await client
    .from("campaign_contacts")
    .delete()
    .eq("organization_id", organizationId)
    .eq("campaign_id", campaignId)
    .in("contact_id", contactIds)
    .select("contact_id");

  if (error) return error.message;

  const removedIds = new Set((data ?? []).map((row) => row.contact_id));
  if (contactIds.some((contactId) => !removedIds.has(contactId))) {
    return "Added recipients could not be fully rolled back.";
  }

  return null;
}

/**
 * Puts back recipients that were removed before a later step failed.
 * Without this a partially applied update would silently drop recipients.
 */
async function restoreRemovedRecipients(client, organizationId, campaignId, contactIds) {
  if (!contactIds.length) return null;

  const recipientRows = contactIds.map((contactId) => ({
    organization_id: organizationId,
    campaign_id: campaignId,
    contact_id: contactId,
    status: "pending",
  }));

  const { error } = await client.from("campaign_contacts").insert(recipientRows);
  if (error) return error.message;

  return null;
}

function safePageValues(page, pageSize) {
  const requestedPage = Number(page);
  const requestedPageSize = Number(pageSize);
  const safePage = Number.isFinite(requestedPage)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(requestedPage)))
    : 1;
  const safePageSize = Number.isFinite(requestedPageSize)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(requestedPageSize)))
    : 20;

  return {
    page: safePage,
    pageSize: safePageSize,
    offset: getPaginationOffset(safePage, safePageSize),
  };
}

/**
 * A campaign that says "scheduled" must have a date to run on. The check uses
 * the value that will actually be stored, so editing an already scheduled
 * campaign without touching its date keeps working.
 */
function scheduledDateFailure(status, scheduledAt) {
  if (status === "scheduled" && !scheduledAt) {
    return actionFailure(
      "A scheduled campaign needs a schedule date and time.",
      ACTION_ERROR_CODES.VALIDATION
    );
  }
  return null;
}

export async function listCampaigns({ page = 1, pageSize = 20, status } = {}) {
  const client = await createClient();
  const context = await resolveCampaignContext(client);
  if (!context.ok) return context;

  const { organizationId, role } = context.data;
  const pagination = safePageValues(page, pageSize);

  let query = client
    .from("campaigns")
    .select("*", { count: "exact" })
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true });

  if (status != null && status !== "") {
    const result = validateCampaignStatus(status);
    if (!result.valid) {
      return actionFailure(result.error, ACTION_ERROR_CODES.VALIDATION);
    }
    query = query.eq("status", status);
  }

  const { data, count, error } = await query.range(
    pagination.offset,
    pagination.offset + pagination.pageSize - 1
  );
  if (error) {
    console.error("campaigns: could not load campaigns", error);
    return actionFailure("Could not load campaigns. Please try again.");
  }

  const campaigns = (data ?? []).map(fromCampaignRecord);
  const counts = await fetchCampaignRecipientCounts(
    client,
    organizationId,
    campaigns.map((campaign) => campaign.id)
  );
  if (counts && counts.ok === false) return counts;

  return actionSuccess({
    campaigns: campaigns.map((campaign) => ({
      ...campaign,
      recipientCount: counts?.[campaign.id] ?? 0,
    })),
    pagination: {
      ...pagination,
      totalCount: count ?? 0,
      pageCount: getPageCount(count ?? 0, pagination.pageSize),
    },
    permissions: {
      canManage: campaignWriteRoles.includes(role),
      canDelete: campaignDeleteRoles.includes(role),
      canRemoveRecipients: campaignDeleteRoles.includes(role),
    },
  });
}

export async function createCampaign(campaign, recipientContactIds = []) {
  const client = await createClient();
  const context = await resolveCampaignContext(client);
  if (!context.ok) return context;

  const roleFailure = requireCampaignRole(context.data.role, campaignWriteRoles);
  if (roleFailure) return roleFailure;

  const normalized = normalizeCampaignInput(campaign);
  if (normalized.error) return normalized.error;
  const campaignRecord = normalized.record;

  const normalizedRecipients = normalizeRecipientContactIds(recipientContactIds);
  if (normalizedRecipients.error) return normalizedRecipients.error;
  const contactIds = normalizedRecipients.ids;

  const dateFailure = scheduledDateFailure(
    campaignRecord.status,
    campaignRecord.scheduled_at
  );
  if (dateFailure) return dateFailure;

  const contactFailure = await validateOrganizationContacts(
    client,
    context.data.organizationId,
    contactIds
  );
  if (contactFailure) return contactFailure;

  const { data: createdCampaign, error: createError } = await client
    .from("campaigns")
    .insert({
      ...campaignRecord,
      organization_id: context.data.organizationId,
      created_by: context.data.user.id,
    })
    .select("*")
    .single();

  if (createError) {
    console.error("campaigns: could not create campaign", createError);
    return actionFailure("Could not create the campaign. Please try again.");
  }

  const recipientFailure = await insertRecipientAssociations(
    client,
    context.data.organizationId,
    createdCampaign.id,
    contactIds
  );

  if (recipientFailure) {
    const cleanup = await client
      .from("campaigns")
      .delete()
      .eq("id", createdCampaign.id)
      .eq("organization_id", context.data.organizationId)
      .select("id")
      .maybeSingle();

    if (cleanup.error || !cleanup.data) {
      console.error(
        "campaigns: recipient insert failed and the campaign cleanup also failed",
        cleanup.error
      );
      return actionFailure(
        "The campaign recipients were not saved and the campaign could not be removed automatically. Please delete the empty campaign and try again."
      );
    }

    return actionFailure(
      "The campaign was not created because its recipients could not be saved. Please try again."
    );
  }

  return actionSuccess({
    ...fromCampaignRecord(createdCampaign),
    recipientCount: contactIds.length,
  });
}

export async function updateCampaign(campaignId, changes, recipientContactIds) {
  const client = await createClient();
  const context = await resolveCampaignContext(client);
  if (!context.ok) return context;

  const roleFailure = requireCampaignRole(context.data.role, campaignWriteRoles);
  if (roleFailure) return roleFailure;

  const normalized = normalizeCampaignInput(changes, { partial: true });
  if (normalized.error) return normalized.error;
  const campaignRecord = normalized.record;

  if (recipientContactIds === undefined && !Object.keys(campaignRecord).length) {
    return actionFailure(
      "Provide campaign fields or recipient changes to update.",
      ACTION_ERROR_CODES.VALIDATION
    );
  }

  const { data: originalCampaign, error: lookupError } = await client
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .eq("organization_id", context.data.organizationId)
    .maybeSingle();

  if (lookupError) {
    console.error("campaigns: could not look up the campaign to update", lookupError);
    return actionFailure("Could not find the campaign to update. Please try again.");
  }
  if (!originalCampaign) {
    return actionFailure(
      "That campaign was not found in your organization.",
      ACTION_ERROR_CODES.NOT_FOUND
    );
  }

  const effectiveStatus = campaignRecord.status ?? originalCampaign.status;
  const effectiveScheduledAt = Object.hasOwn(campaignRecord, "scheduled_at")
    ? campaignRecord.scheduled_at
    : originalCampaign.scheduled_at;
  const dateFailure = scheduledDateFailure(effectiveStatus, effectiveScheduledAt);
  if (dateFailure) return dateFailure;

  let addedContactIds = [];
  let removedContactIds = [];
  let shouldReplaceRecipients = recipientContactIds !== undefined;
  let desiredRecipientIds = [];

  if (shouldReplaceRecipients) {
    const normalizedRecipients = normalizeRecipientContactIds(recipientContactIds);
    if (normalizedRecipients.error) return normalizedRecipients.error;
    desiredRecipientIds = normalizedRecipients.ids;

    const contactFailure = await validateOrganizationContacts(
      client,
      context.data.organizationId,
      desiredRecipientIds
    );
    if (contactFailure) return contactFailure;

    const existingIds = await listExistingRecipientIds(
      client,
      context.data.organizationId,
      campaignId
    );
    if (existingIds && existingIds.ok === false) return existingIds;

    const existingSet = new Set(existingIds);
    const desiredSet = new Set(desiredRecipientIds);
    addedContactIds = desiredRecipientIds.filter((contactId) => !existingSet.has(contactId));
    removedContactIds = existingIds.filter((contactId) => !desiredSet.has(contactId));

    if (removedContactIds.length && !campaignDeleteRoles.includes(context.data.role)) {
      return actionFailure(
        "Only an ADMIN can remove recipients from a campaign.",
        ACTION_ERROR_CODES.PERMISSION_DENIED
      );
    }
  }

  const updatedColumns = Object.keys(campaignRecord);
  let updatedCampaign = originalCampaign;

  if (updatedColumns.length) {
    const { data, error } = await client
      .from("campaigns")
      .update({ ...campaignRecord, updated_at: new Date().toISOString() })
      .eq("id", campaignId)
      .eq("organization_id", context.data.organizationId)
      .select("*")
      .single();

    if (error) {
      console.error("campaigns: could not update campaign", error);
      return actionFailure("Could not update the campaign. Please try again.");
    }
    updatedCampaign = data;
  }

  let removedRecipientIds = [];

  try {
    const insertFailure = await insertRecipientAssociations(
      client,
      context.data.organizationId,
      campaignId,
      addedContactIds
    );
    if (insertFailure) throw insertFailure;

    const removal = await removeRecipientAssociations(
      client,
      context.data.organizationId,
      campaignId,
      removedContactIds
    );
    if (removal.error) throw removal.error;

    removedRecipientIds = removal.removedIds;
    if (removal.missingIds.length) {
      throw actionFailure(
        "Some campaign recipients could not be removed. Check your ADMIN permissions and try again.",
        ACTION_ERROR_CODES.PERMISSION_DENIED
      );
    }
  } catch (recipientError) {
    const rollbackErrors = [];

    if (addedContactIds.length) {
      const cleanupError = await cleanupAddedRecipients(
        client,
        context.data.organizationId,
        campaignId,
        addedContactIds
      );
      if (cleanupError) rollbackErrors.push(`Added recipients could not be rolled back: ${cleanupError}`);
    }

    // Put back any recipient that was already removed before the failure, so a
    // partially applied update does not silently drop people from a campaign.
    if (removedRecipientIds.length) {
      const restoreError = await restoreRemovedRecipients(
        client,
        context.data.organizationId,
        campaignId,
        removedRecipientIds
      );
      if (restoreError) {
        rollbackErrors.push(`Removed recipients could not be restored: ${restoreError}`);
      }
    }

    const campaignRestoreError = await restoreCampaignFields(
      client,
      context.data.organizationId,
      campaignId,
      originalCampaign,
      updatedColumns
    );
    if (campaignRestoreError) rollbackErrors.push(campaignRestoreError);

    const originalMessage = recipientError?.error
      ?? recipientError?.message
      ?? "Could not update campaign recipients.";
    const rollbackMessage = rollbackErrors.length
      ? ` Rollback was incomplete: ${rollbackErrors.join(" ")}`
      : " Campaign field changes were rolled back.";

    console.error("campaigns: recipient update failed and was rolled back", recipientError);
    return actionFailure(`${originalMessage}${rollbackMessage}`);
  }

  const countsByCampaignId = shouldReplaceRecipients
    ? { [campaignId]: desiredRecipientIds.length }
    : await fetchCampaignRecipientCounts(client, context.data.organizationId, [campaignId]);
  if (countsByCampaignId && countsByCampaignId.ok === false) return countsByCampaignId;

  return actionSuccess({
    ...fromCampaignRecord(updatedCampaign),
    recipientCount: countsByCampaignId?.[campaignId] ?? 0,
  });
}

export async function deleteCampaign(campaignId) {
  const client = await createClient();
  const context = await resolveCampaignContext(client);
  if (!context.ok) return context;

  const roleFailure = requireCampaignRole(context.data.role, campaignDeleteRoles);
  if (roleFailure) return roleFailure;

  const { data, error } = await client
    .from("campaigns")
    .delete()
    .eq("id", campaignId)
    .eq("organization_id", context.data.organizationId)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("campaigns: could not delete campaign", error);
    return actionFailure("Could not delete the campaign. Please try again.");
  }
  if (!data) {
    return actionFailure(
      "That campaign was not found in your organization.",
      ACTION_ERROR_CODES.NOT_FOUND
    );
  }

  return actionSuccess(data.id);
}

export async function listCampaignRecipientContacts({ page = 1, pageSize = 20 } = {}) {
  const client = await createClient();
  const context = await resolveCampaignContext(client);
  if (!context.ok) return context;

  const { organizationId } = context.data;
  const pagination = safePageValues(page, pageSize);

  const { data, count, error } = await client
    .from("contacts")
    .select("id, first_name, last_name, email, phone, company, status, created_at", { count: "exact" })
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(pagination.offset, pagination.offset + pagination.pageSize - 1);

  if (error) {
    console.error("campaigns: could not load contacts for campaign recipients", error);
    return actionFailure("Could not load the contacts for campaign recipients. Please try again.");
  }

  return actionSuccess({
    contacts: (data ?? []).map(fromContactRecord),
    pagination: {
      ...pagination,
      totalCount: count ?? 0,
      pageCount: getPageCount(count ?? 0, pagination.pageSize),
    },
  });
}

export async function listCampaignRecipientIds(campaignId) {
  const client = await createClient();
  const context = await resolveCampaignContext(client);
  if (!context.ok) return context;

  const { organizationId } = context.data;

  if (typeof campaignId !== "string" || !campaignId.trim()) {
    return actionFailure(
      "A valid campaign ID is required to load recipients.",
      ACTION_ERROR_CODES.VALIDATION
    );
  }

  const { data, error } = await client
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    console.error("campaigns: could not look up the campaign", error);
    return actionFailure("Could not find the campaign. Please try again.");
  }
  if (!data) {
    return actionFailure(
      "That campaign was not found in your organization.",
      ACTION_ERROR_CODES.NOT_FOUND
    );
  }

  const recipientIds = await listExistingRecipientIds(client, organizationId, campaignId);
  if (recipientIds && recipientIds.ok === false) return recipientIds;

  return actionSuccess(recipientIds);
}

export async function getCampaignRecipientCounts(campaignIds) {
  const client = await createClient();
  const context = await resolveCampaignContext(client);
  if (!context.ok) return context;

  const { organizationId } = context.data;
  let scopedCampaignIds = null;

  if (campaignIds !== undefined) {
    if (!Array.isArray(campaignIds)) {
      return actionFailure(
        "Campaign IDs must be provided as a list.",
        ACTION_ERROR_CODES.VALIDATION
      );
    }

    scopedCampaignIds = [...new Set(campaignIds)];
    if (scopedCampaignIds.some((id) => typeof id !== "string" || !id.trim())) {
      return actionFailure(
        "Every campaign must have a valid campaign ID.",
        ACTION_ERROR_CODES.VALIDATION
      );
    }
  }

  const counts = await fetchCampaignRecipientCounts(client, organizationId, scopedCampaignIds);
  if (counts && counts.ok === false) return counts;

  return actionSuccess(counts);
}
