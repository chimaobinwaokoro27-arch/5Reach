export const contactStatuses = ["active", "inactive", "archived"];

const contactFieldMap = {
  firstName: "first_name",
  lastName: "last_name",
  email: "email",
  phone: "phone",
  company: "company",
  status: "status",
};

const recordFieldMap = {
  ...contactFieldMap,
  id: "id",
  createdBy: "created_by",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

export function toContactRecord(contact) {
  return Object.fromEntries(
    Object.entries(contactFieldMap)
      .filter(([field]) => Object.hasOwn(contact, field) && contact[field] !== undefined)
      .map(([field, column]) => [column, contact[field]])
  );
}

export function fromContactRecord(record) {
  if (!record) return null;

  return Object.fromEntries(
    Object.entries(recordFieldMap)
      .filter(([, column]) => Object.hasOwn(record, column))
      .map(([field, column]) => [field, record[column]])
  );
}

export function normalizePhoneNumber(phone) {
  if (typeof phone !== "string" || !phone.trim()) return null;

  const trimmedPhone = phone.trim();
  const extensionMatch = trimmedPhone.match(/(?:ext(?:ension)?\.?|x|#)\s*(\d+)$/i);
  const mainNumber = extensionMatch
    ? trimmedPhone.slice(0, extensionMatch.index)
    : trimmedPhone;
  const digits = mainNumber.replace(/\D/g, "");

  if (!digits) return null;

  return extensionMatch
    ? `${digits};ext=${extensionMatch[1]}`
    : digits;
}

export function validatePhoneNumber(phone) {
  if (phone == null || (typeof phone === "string" && phone.trim() === "")) {
    return { valid: true, error: null };
  }

  if (typeof phone !== "string") {
    return { valid: false, error: "Phone number must be text." };
  }

  const extensionMatch = phone.match(/(?:ext(?:ension)?\.?|x|#)\s*\d+\s*$/i);
  const numberPart = extensionMatch
    ? phone.slice(0, extensionMatch.index)
    : phone;
  const allowedPhoneCharacters = /^\s*\+?[\d\s().\/-]+\s*$/;
  const digitCount = numberPart.replace(/\D/g, "").length;

  if (
    !allowedPhoneCharacters.test(numberPart)
    || digitCount < 2
    || digitCount > 15
  ) {
    return {
      valid: false,
      error: "Enter a phone number with 2 to 15 digits and a leading + for international format.",
    };
  }

  return { valid: true, error: null };
}

export function validateContactStatus(status) {
  if (!contactStatuses.includes(status)) {
    return {
      valid: false,
      value: null,
      error: `Contact status must be one of: ${contactStatuses.join(", ")}.`,
    };
  }

  return { valid: true, value: status, error: null };
}

export function validateContactEmail(email) {
  if (email == null || (typeof email === "string" && email.trim() === "")) {
    return { valid: true, error: null };
  }

  if (typeof email !== "string") {
    return { valid: false, error: "Email address must be text." };
  }

  // Deliberately permissive: one "@", no whitespace, a dotted domain.
  // Catches obvious junk without rejecting unusual but legitimate addresses.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return { valid: false, error: "Enter a valid email address." };
  }

  return { valid: true, error: null };
}

export function findDuplicateContactFields(contact, existingContacts, ignoredContactId) {
  const email = typeof contact.email === "string" ? contact.email.trim().toLowerCase() : "";
  const phone = normalizePhoneNumber(contact.phone);
  const duplicates = new Set();

  for (const existingContact of existingContacts) {
    if (ignoredContactId != null && existingContact.id === ignoredContactId) continue;

    const existingEmail = typeof existingContact.email === "string"
      ? existingContact.email.trim().toLowerCase()
      : "";

    if (email && email === existingEmail) duplicates.add("email");
    if (phone && phone === normalizePhoneNumber(existingContact.phone)) duplicates.add("phone");
  }

  return [...duplicates];
}

export function getPaginationOffset(page, pageSize) {
  const safePage = toSafeInteger(page, 1, 1);
  const safePageSize = toSafeInteger(pageSize, 1, 1);
  const maximumOffset = Number.MAX_SAFE_INTEGER - safePageSize + 1;

  return Math.min((safePage - 1) * safePageSize, maximumOffset);
}

export function getPageCount(totalCount, pageSize) {
  const safeTotalCount = toSafeInteger(totalCount, 0, 0);
  const safePageSize = toSafeInteger(pageSize, 1, 1);

  return Math.ceil(safeTotalCount / safePageSize);
}

function toSafeInteger(value, fallback, minimum) {
  let numericValue;

  try {
    numericValue = Number(value);
  } catch {
    return fallback;
  }

  if (!Number.isFinite(numericValue)) return fallback;

  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(minimum, Math.floor(numericValue))
  );
}