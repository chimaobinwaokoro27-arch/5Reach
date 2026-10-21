"use client";

import { DashboardShell } from '@/components/layout/DashboardShell';
import { useEffect, useState } from 'react';
import { Search, Plus, Edit2, Loader2, Trash2 } from 'lucide-react';
import { createContact, deleteContact, listContacts, updateContact } from '@/lib/contacts-data';
import { findDuplicateContactFields, validatePhoneNumber } from '@/lib/contact-utils';
import { ACTION_ERROR_CODES } from '@/lib/action-result';

const contactPageSize = 1000;
const visibleContactPageSize = 10;

async function fetchAllContacts() {
  const contacts = [];
  let page = 1;
  let pageCount = 1;
  let permissions = null;

  while (page <= pageCount) {
    const result = await listContacts({ page, pageSize: contactPageSize });
    if (!result.ok) return result;
    contacts.push(...result.data.contacts);
    permissions ??= result.data.permissions;
    pageCount = result.data.pagination.pageCount;
    page += 1;
  }

  return { ok: true, data: { contacts, permissions } };
}

function isSignedOut(result) {
  return result?.code === ACTION_ERROR_CODES.AUTH_REQUIRED;
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState([]);
  const [contactPermissions, setContactPermissions] = useState({
    canCreate: false,
    canUpdate: false,
    canDelete: false,
  });
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedContacts, setSelectedContacts] = useState([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingContact, setEditingContact] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingContacts, setIsLoadingContacts] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSignedOut, setIsSignedOut] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionFeedback, setActionFeedback] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    company: '',
    status: 'active',
  });

  useEffect(() => {
    let isCurrent = true;

    async function loadContacts() {
      setIsLoadingContacts(true);
      setIsSignedOut(false);
      setLoadError('');

      try {
        const loaded = await fetchAllContacts();
        if (!isCurrent) return;

        if (!loaded.ok) {
          setContacts([]);
          setContactPermissions({ canCreate: false, canUpdate: false, canDelete: false });
          if (isSignedOut(loaded)) {
            setIsSignedOut(true);
          } else {
            setLoadError(loaded.error || 'Could not load contacts.');
          }
          return;
        }

        setContacts(loaded.data.contacts);
        setContactPermissions(loaded.data.permissions ?? {
          canCreate: false,
          canUpdate: false,
          canDelete: false,
        });
      } catch (error) {
        if (!isCurrent) return;

        setContacts([]);
        setContactPermissions({ canCreate: false, canUpdate: false, canDelete: false });
        setLoadError(error instanceof Error ? error.message : 'Could not load contacts.');
      } finally {
        if (isCurrent) setIsLoadingContacts(false);
      }
    }

    loadContacts();

    return () => {
      isCurrent = false;
    };
  }, [refreshKey]);

  const filteredContacts = contacts.filter((contact) => {
    const needle = searchTerm.trim().toLowerCase();
    const matchesSearch =
      !needle ||
      (contact.firstName?.toLowerCase().includes(needle) || false) ||
      (contact.lastName?.toLowerCase().includes(needle) || false) ||
      (contact.email?.toLowerCase().includes(needle) || false) ||
      (contact.phone?.toLowerCase().includes(needle) || false) ||
      (contact.company?.toLowerCase().includes(needle) || false);
    const matchesStatus = statusFilter === 'all' || contact.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const pageCount = Math.ceil(filteredContacts.length / visibleContactPageSize);
  const safeCurrentPage = Math.min(currentPage, Math.max(1, pageCount));
  const firstVisibleContactIndex = (safeCurrentPage - 1) * visibleContactPageSize;
  const visibleContacts = filteredContacts.slice(
    firstVisibleContactIndex,
    firstVisibleContactIndex + visibleContactPageSize
  );

  const handleSelectAll = (e) => {
    const visibleIds = visibleContacts.map((contact) => contact.id);
    if (e.target.checked) {
      // Keep contacts picked on other pages selected.
      setSelectedContacts((selected) => [...new Set([...selected, ...visibleIds])]);
    } else {
      setSelectedContacts((selected) => selected.filter((id) => !visibleIds.includes(id)));
    }
  };

  const handleSelectContact = (contactId) => {
    if (selectedContacts.includes(contactId)) {
      setSelectedContacts(selectedContacts.filter((id) => id !== contactId));
    } else {
      setSelectedContacts([...selectedContacts, contactId]);
    }
  };

  const handleDeleteContact = async (contact) => {
    const contactName = `${contact.firstName} ${contact.lastName || ''}`.trim();
    if (!window.confirm(`Delete ${contactName}? This action cannot be undone.`)) return;

    setIsDeleting(true);
    setActionError('');
    setActionFeedback('');

    try {
      const result = await deleteContact(contact.id);
      if (!result.ok) {
        setActionError(result.error || 'Could not delete this contact.');
        if (isSignedOut(result)) setIsSignedOut(true);
        return;
      }

      setSelectedContacts((selected) => selected.filter((id) => id !== contact.id));
      setActionFeedback('Contact deleted.');
      setRefreshKey((currentKey) => currentKey + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not delete this contact.');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleBulkDelete = async () => {
    if (!selectedContacts.length) return;

    const count = selectedContacts.length;
    const label = count === 1 ? 'contact' : 'contacts';
    if (!window.confirm(`Delete ${count} selected ${label}? This action cannot be undone.`)) return;

    setIsDeleting(true);
    setActionError('');
    setActionFeedback('');

    const results = await Promise.allSettled(
      selectedContacts.map((contactId) => deleteContact(contactId))
    );

    const deletedIds = [];
    const failures = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value?.ok) {
        deletedIds.push(selectedContacts[index]);
        return;
      }
      failures.push(
        result.status === 'fulfilled'
          ? result.value
          : {
              ok: false,
              error: result.reason instanceof Error
                ? result.reason.message
                : 'Could not delete this contact.',
            }
      );
    });

    setSelectedContacts([]);
    if (deletedIds.length) setRefreshKey((currentKey) => currentKey + 1);

    if (failures.length) {
      const firstFailure = failures[0];
      const reason = firstFailure.error ? ` ${firstFailure.error}` : '';
      setActionError(
        `Deleted ${deletedIds.length} of ${count} selected contacts. ${failures.length} could not be deleted.${reason}`
      );
      if (failures.some((result) => isSignedOut(result))) setIsSignedOut(true);
    } else {
      setActionFeedback(`Deleted ${deletedIds.length} ${label}.`);
    }

    setIsDeleting(false);
  };

  const handleAddContact = () => {
    setEditingContact(null);
    setFormError('');
    setFormData({ firstName: '', lastName: '', email: '', phone: '', company: '', status: 'active' });
    setIsFormOpen(true);
  };

  const handleEditContact = (contact) => {
    setEditingContact(contact);
    setFormError('');
    setFormData({
      firstName: contact.firstName || '',
      lastName: contact.lastName || '',
      email: contact.email || '',
      phone: contact.phone || '',
      company: contact.company || '',
      status: contact.status || 'active',
    });
    setIsFormOpen(true);
  };

  const handleFormSubmit = async (e) => {
    e.preventDefault();
    if (!formData.firstName.trim()) {
      setFormError('A first name is required.');
      return;
    }

    const phoneValidation = validatePhoneNumber(formData.phone);
    if (!phoneValidation.valid) {
      setFormError(phoneValidation.error);
      return;
    }

    const duplicateFields = findDuplicateContactFields(
      formData,
      contacts,
      editingContact?.id
    );
    if (duplicateFields.length) {
      const duplicateLabels = duplicateFields.map((field) => (
        field === 'email' ? 'email address' : 'phone number'
      ));
      setFormError(
        `A contact with this ${duplicateLabels.join(' and ')} already exists in your organization.`
      );
      return;
    }

    setIsLoading(true);
    setFormError('');
    setActionError('');
    setActionFeedback('');

    try {
      const result = editingContact
        ? await updateContact(editingContact.id, formData)
        : await createContact(formData);

      if (!result.ok) {
        setFormError(result.error || 'Could not save this contact.');
        if (isSignedOut(result)) setIsSignedOut(true);
        return;
      }

      setIsFormOpen(false);
      setSelectedContacts([]);
      setCurrentPage(1);
      setActionFeedback(editingContact ? 'Contact updated.' : 'Contact created.');
      setRefreshKey((currentKey) => currentKey + 1);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not save this contact.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <DashboardShell title="Contacts">
      <div className="space-y-6">
        <div className="bg-[#202326] border border-[#2A2C30] rounded-xl p-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
            <div className="flex flex-col sm:flex-row gap-3 flex-1">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-[#92979D]" />
                <input
                  type="text"
                  placeholder="Search contacts..."
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value);
                    setCurrentPage(1);
                    setSelectedContacts([]);
                  }}
                  className="w-full pl-9 pr-4 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] placeholder-[#92979D] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setCurrentPage(1);
                  setSelectedContacts([]);
                }}
                className="px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
              >
                <option value="all">All Status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="archived">Archived</option>
              </select>
            </div>
            <button
              type="button"
              onClick={handleAddContact}
              disabled={isLoadingContacts || isSignedOut || !contactPermissions.canCreate}
              className="flex items-center gap-2 px-4 py-2 bg-[#E8793E] text-white rounded-lg text-sm font-medium hover:bg-[#d66a2f] transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:ring-offset-2 focus:ring-offset-[#202326]"
            >
              <Plus className="w-4 h-4" />
              Add Contact
            </button>
          </div>
          {!isLoadingContacts && !isSignedOut && !loadError && !contactPermissions.canCreate && (
            <p className="mb-4 text-sm text-[#92979D]">You have read-only access to contacts.</p>
          )}
          {contactPermissions.canDelete && selectedContacts.length > 0 && (
            <div className="bg-[#E8793E]/10 border border-[#E8793E]/30 rounded-lg p-3 mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-sm text-[#F3EFE8]">
                {selectedContacts.length} contact{selectedContacts.length !== 1 ? 's' : ''} selected
              </p>
              <button
                type="button"
                onClick={handleBulkDelete}
                disabled={isDeleting || isLoadingContacts || isSignedOut}
                className="inline-flex items-center gap-2 self-start sm:self-auto text-sm font-medium text-[#E8793E] hover:text-[#F3EFE8] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-4 h-4" />
                Delete selected
              </button>
            </div>
          )}
          {actionError && (
            <p role="alert" className="mb-4 rounded-lg border border-red-900/50 bg-red-950/40 p-3 text-sm text-red-300">
              {actionError}
            </p>
          )}
          {actionFeedback && (
            <p role="status" className="mb-4 rounded-lg border border-[#72B89A]/40 bg-[#72B89A]/10 p-3 text-sm text-[#72B89A]">
              {actionFeedback}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px]">
              <thead>
                <tr className="border-b border-[#2A2C30]">
                  <th className="text-left py-3 px-4">
                    <input
                      type="checkbox"
                      checked={visibleContacts.length > 0 && visibleContacts.every((contact) => selectedContacts.includes(contact.id))}
                      disabled={isLoadingContacts || isDeleting || visibleContacts.length === 0 || !contactPermissions.canDelete}
                      onChange={handleSelectAll}
                      className="rounded border-[#2A2C30] bg-[#151719] text-[#E8793E] focus:ring-[#E8793E]"
                    />
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[#92979D] uppercase tracking-wider">Name</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[#92979D] uppercase tracking-wider">Email</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[#92979D] uppercase tracking-wider">Phone</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[#92979D] uppercase tracking-wider">Company</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[#92979D] uppercase tracking-wider">Status</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[#92979D] uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoadingContacts ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-sm text-[#92979D]">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading contacts...
                      </span>
                    </td>
                  </tr>
                ) : isSignedOut ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-sm text-[#92979D]">
                      You are signed out. Sign in to view your organization&apos;s contacts.
                    </td>
                  </tr>
                ) : loadError ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-sm text-red-300">
                      <p>Could not load contacts: {loadError}</p>
                      <button
                        type="button"
                        onClick={() => setRefreshKey((currentKey) => currentKey + 1)}
                        className="mt-2 font-medium text-[#E8793E] hover:text-[#F3EFE8]"
                      >
                        Try again
                      </button>
                    </td>
                  </tr>
                ) : visibleContacts.map((contact) => (
                  <tr key={contact.id} className="border-b border-[#2A2C30] hover:bg-[#2A2C30]/50">
                    <td className="py-3 px-4">
                      <input
                        type="checkbox"
                        checked={selectedContacts.includes(contact.id)}
                        disabled={isDeleting || !contactPermissions.canDelete}
                        onChange={() => handleSelectContact(contact.id)}
                        className="rounded border-[#2A2C30] bg-[#151719] text-[#E8793E] focus:ring-[#E8793E]"
                      />
                    </td>
                    <td className="py-3 px-4 text-sm text-[#F3EFE8]">
                      {contact.firstName} {contact.lastName}
                    </td>
                    <td className="py-3 px-4 text-sm text-[#92979D] truncate max-w-[200px]">{contact.email}</td>
                    <td className="py-3 px-4 text-sm text-[#92979D]">{contact.phone}</td>
                    <td className="py-3 px-4 text-sm text-[#92979D]">{contact.company}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                        contact.status === 'active'
                          ? 'bg-[#72B89A]/10 text-[#72B89A]'
                          : contact.status === 'inactive'
                          ? 'bg-[#E8793E]/10 text-[#E8793E]'
                          : 'bg-[#92979D]/10 text-[#92979D]'
                      }`}>
                        {contact.status}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {contactPermissions.canUpdate && (
                        <button
                          type="button"
                          onClick={() => handleEditContact(contact)}
                          disabled={isLoadingContacts || isSignedOut || isDeleting}
                          className="flex items-center gap-1 text-sm text-[#E8793E] hover:text-[#F3EFE8] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Edit2 className="w-3 h-3" />
                          Edit
                        </button>
                      )}
                      {contactPermissions.canDelete && (
                        <button
                          type="button"
                          onClick={() => handleDeleteContact(contact)}
                          disabled={isLoadingContacts || isSignedOut || isDeleting}
                          className="mt-2 flex items-center gap-1 text-sm font-medium text-red-400 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="w-3 h-3" />
                          Delete
                        </button>
                      )}
                      {!contactPermissions.canUpdate && !contactPermissions.canDelete && (
                        <span className="text-sm text-[#92979D]">Read only</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!isLoadingContacts && !isSignedOut && !loadError && filteredContacts.length === 0 && (
              <div className="text-center py-8">
                <p className="text-[#92979D]">No contacts found</p>
              </div>
            )}
          </div>
          {!isLoadingContacts && !isSignedOut && !loadError && pageCount > 1 && (
            <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-t border-[#2A2C30] pt-4">
              <p className="text-sm text-[#92979D]">
                Showing {firstVisibleContactIndex + 1}-{Math.min(firstVisibleContactIndex + visibleContacts.length, filteredContacts.length)} of {filteredContacts.length}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setCurrentPage(safeCurrentPage - 1);
                    setSelectedContacts([]);
                  }}
                  disabled={safeCurrentPage === 1 || isDeleting}
                  className="px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] hover:bg-[#2A2C30] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span className="text-sm text-[#92979D]">Page {safeCurrentPage} of {pageCount}</span>
                <button
                  type="button"
                  onClick={() => {
                    setCurrentPage(safeCurrentPage + 1);
                    setSelectedContacts([]);
                  }}
                  disabled={safeCurrentPage >= pageCount || isDeleting}
                  className="px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] hover:bg-[#2A2C30] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {isFormOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50">
          <div className="bg-[#202326] border border-[#2A2C30] rounded-xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-[#F3EFE8] mb-4">
              {editingContact ? 'Edit Contact' : 'Add Contact'}
            </h2>
            <form onSubmit={handleFormSubmit} className="space-y-4">
              {formError && (
                <p role="alert" className="text-sm text-red-300">
                  {formError}
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="contact-first-name" className="block text-sm font-medium text-[#F3EFE8] mb-1">First Name *</label>
                  <input
                    id="contact-first-name"
                    type="text"
                    value={formData.firstName}
                    onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                    className="w-full px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] placeholder-[#92979D] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="contact-last-name" className="block text-sm font-medium text-[#F3EFE8] mb-1">Last Name</label>
                  <input
                    id="contact-last-name"
                    type="text"
                    value={formData.lastName}
                    onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                    className="w-full px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] placeholder-[#92979D] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="contact-email" className="block text-sm font-medium text-[#F3EFE8] mb-1">Email</label>
                <input
                  id="contact-email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] placeholder-[#92979D] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
                />
              </div>
              <div>
                <label htmlFor="contact-phone" className="block text-sm font-medium text-[#F3EFE8] mb-1">Phone</label>
                <input
                  id="contact-phone"
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="w-full px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] placeholder-[#92979D] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
                />
              </div>
              <div>
                <label htmlFor="contact-company" className="block text-sm font-medium text-[#F3EFE8] mb-1">Company</label>
                <input
                  id="contact-company"
                  type="text"
                  value={formData.company}
                  onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                  className="w-full px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] placeholder-[#92979D] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
                />
              </div>
              <div>
                <label htmlFor="contact-status" className="block text-sm font-medium text-[#F3EFE8] mb-1">Status</label>
                <select
                  id="contact-status"
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  className="w-full px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
              <div className="flex flex-col sm:flex-row gap-3 pt-4">
                <button
                  type="submit"
                  disabled={isLoading || !(editingContact ? contactPermissions.canUpdate : contactPermissions.canCreate)}
                  className="flex-1 px-4 py-2 bg-[#E8793E] text-white rounded-lg text-sm font-medium hover:bg-[#d66a2f] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:ring-offset-2 focus:ring-offset-[#202326]"
                >
                  {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {editingContact ? 'Update' : 'Add'}
                </button>
                <button
                  type="button"
                  onClick={() => setIsFormOpen(false)}
                  className="flex-1 px-4 py-2 bg-transparent border border-[#2A2C30] text-[#F3EFE8] rounded-lg text-sm font-medium hover:bg-[#2A2C30] transition-colors focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:ring-offset-2 focus:ring-offset-[#202326]"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
