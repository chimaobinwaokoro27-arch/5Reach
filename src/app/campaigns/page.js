"use client";

import { DashboardShell } from '@/components/layout/DashboardShell';
import { useEffect, useState } from 'react';
import { Search, Plus, Loader2, Pencil, Trash2 } from 'lucide-react';
import {
  createCampaign,
  deleteCampaign,
  listCampaigns,
  listCampaignRecipientContacts,
  listCampaignRecipientIds,
  updateCampaign,
} from '@/lib/campaigns-data';
import {
  campaignStatuses,
  validateCampaignChannel,
  validateCampaignName,
  validateCampaignStatus,
  toScheduledAtIso,
} from '@/lib/campaign-utils';
import { ACTION_ERROR_CODES } from '@/lib/action-result';

const campaignPageSize = 1000;

async function fetchAllCampaigns() {
  const campaigns = [];
  let page = 1;
  let pageCount = 1;
  let permissions = null;

  while (page <= pageCount) {
    const result = await listCampaigns({ page, pageSize: campaignPageSize });
    if (!result.ok) return result;
    campaigns.push(...result.data.campaigns);
    permissions ??= result.data.permissions;
    pageCount = result.data.pagination.pageCount;
    page += 1;
  }

  return { ok: true, data: { campaigns, permissions } };
}

async function fetchAllRecipientContacts() {
  const contacts = [];
  let page = 1;
  let pageCount = 1;

  while (page <= pageCount) {
    const result = await listCampaignRecipientContacts({ page, pageSize: campaignPageSize });
    if (!result.ok) return result;
    contacts.push(...result.data.contacts);
    pageCount = result.data.pagination.pageCount;
    page += 1;
  }

  return { ok: true, data: contacts };
}

function isSignedOut(result) {
  return result?.code === ACTION_ERROR_CODES.AUTH_REQUIRED;
}

function formatScheduledAt(value) {
  if (!value) return 'Not scheduled';

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Invalid date' : date.toLocaleString();
}

function toDateTimeLocalValue(value) {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState([]);
  const [campaignPermissions, setCampaignPermissions] = useState({
    canManage: false,
    canDelete: false,
    canRemoveRecipients: false,
  });
  const [contacts, setContacts] = useState([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingCampaigns, setIsLoadingCampaigns] = useState(true);
  const [isLoadingContacts, setIsLoadingContacts] = useState(false);
  const [isLoadingRecipients, setIsLoadingRecipients] = useState(false);
  const [isDeletingCampaign, setIsDeletingCampaign] = useState(false);
  const [currentRecipientIds, setCurrentRecipientIds] = useState([]);
  const [isSignedOut, setIsSignedOut] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [contactsError, setContactsError] = useState('');
  const [formError, setFormError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [campaignRefreshKey, setCampaignRefreshKey] = useState(0);
  const [contactsRefreshKey, setContactsRefreshKey] = useState(0);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    channel: 'email',
    status: 'draft',
    scheduledAt: '',
  });
  const [selectedRecipients, setSelectedRecipients] = useState([]);
  const [recipientSearch, setRecipientSearch] = useState('');

  useEffect(() => {
    let isCurrent = true;

    async function loadCampaigns() {
      setIsLoadingCampaigns(true);
      setIsSignedOut(false);
      setLoadError('');

      try {
        const loaded = await fetchAllCampaigns();
        if (!isCurrent) return;

        if (!loaded.ok) {
          setCampaigns([]);
          setCampaignPermissions({ canManage: false, canDelete: false, canRemoveRecipients: false });
          if (isSignedOut(loaded)) {
            setIsSignedOut(true);
          } else {
            setLoadError(loaded.error || 'Could not load campaigns.');
          }
          return;
        }

        setCampaigns(loaded.data.campaigns);
        setCampaignPermissions(loaded.data.permissions ?? {
          canManage: false,
          canDelete: false,
          canRemoveRecipients: false,
        });
      } catch (error) {
        if (!isCurrent) return;

        setCampaigns([]);
        setCampaignPermissions({ canManage: false, canDelete: false, canRemoveRecipients: false });
        setLoadError(error instanceof Error ? error.message : 'Could not load campaigns.');
      } finally {
        if (isCurrent) setIsLoadingCampaigns(false);
      }
    }

    loadCampaigns();

    return () => {
      isCurrent = false;
    };
  }, [campaignRefreshKey]);

  useEffect(() => {
    if (!isFormOpen) return undefined;

    let isCurrent = true;

    async function loadRecipientContacts() {
      setIsLoadingContacts(true);
      setContactsError('');

      try {
        const loadedContacts = await fetchAllRecipientContacts();
        if (!isCurrent) return;

        if (!loadedContacts.ok) {
          setContacts([]);
          setContactsError(loadedContacts.error || 'Could not load contacts.');
          return;
        }

        setContacts(loadedContacts.data);
      } catch (error) {
        if (!isCurrent) return;

        setContacts([]);
        setContactsError(error instanceof Error ? error.message : 'Could not load contacts.');
      } finally {
        if (isCurrent) setIsLoadingContacts(false);
      }
    }

    loadRecipientContacts();

    return () => {
      isCurrent = false;
    };
  }, [isFormOpen, contactsRefreshKey]);

  const filteredRecipients = contacts.filter((contact) => {
    const needle = recipientSearch.trim().toLowerCase();
    const matchesSearch =
      !needle ||
      (contact.firstName?.toLowerCase().includes(needle) || false) ||
      (contact.lastName?.toLowerCase().includes(needle) || false) ||
      (contact.email?.toLowerCase().includes(needle) || false) ||
      (contact.phone?.toLowerCase().includes(needle) || false) ||
      (contact.company?.toLowerCase().includes(needle) || false);
    return matchesSearch;
  });

  const handleFormSubmit = async (e) => {
    e.preventDefault();

    const nameValidation = validateCampaignName(formData.name);
    if (!nameValidation.valid) {
      setFormError(nameValidation.error);
      return;
    }

    const channelValidation = validateCampaignChannel(formData.channel);
    if (!channelValidation.valid) {
      setFormError(channelValidation.error);
      return;
    }

    const statusValidation = validateCampaignStatus(formData.status);
    if (!statusValidation.valid) {
      setFormError(statusValidation.error);
      return;
    }

    const scheduleValidation = toScheduledAtIso(formData.scheduledAt);
    if (!scheduleValidation.valid) {
      setFormError(scheduleValidation.error);
      return;
    }

    if (statusValidation.value === 'scheduled' && !scheduleValidation.value) {
      setFormError('A scheduled campaign needs a schedule date and time.');
      return;
    }

    if (selectedRecipients.length === 0) {
      setFormError('Select at least one recipient.');
      return;
    }

    setIsLoading(true);
    setFormError('');
    setSuccessMessage('');

    try {
      const campaignChanges = {
        ...formData,
        name: nameValidation.value,
        channel: channelValidation.value,
        status: statusValidation.value,
        scheduledAt: scheduleValidation.value,
      };

      const result = editingCampaign
        ? await updateCampaign(editingCampaign.id, campaignChanges, selectedRecipients)
        : await createCampaign(campaignChanges, selectedRecipients);

      if (!result.ok) {
        setFormError(result.error || 'Could not save the campaign.');
        if (isSignedOut(result)) setIsSignedOut(true);
        return;
      }

      setIsFormOpen(false);
      setEditingCampaign(null);
      setFormData({ name: '', description: '', channel: 'email', status: 'draft', scheduledAt: '' });
      setSelectedRecipients([]);
      setCurrentRecipientIds([]);
      setRecipientSearch('');
      setSuccessMessage(editingCampaign ? 'Campaign updated successfully.' : 'Campaign created successfully.');
      setCampaignRefreshKey((currentKey) => currentKey + 1);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not save the campaign.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectRecipient = (contactId) => {
    if (
      editingCampaign
      && !campaignPermissions.canRemoveRecipients
      && currentRecipientIds.includes(contactId)
      && selectedRecipients.includes(contactId)
    ) return;

    if (selectedRecipients.includes(contactId)) {
      setSelectedRecipients(selectedRecipients.filter((id) => id !== contactId));
    } else {
      setSelectedRecipients([...selectedRecipients, contactId]);
    }
  };

  const handleSelectAllRecipients = () => {
    const filteredRecipientIds = filteredRecipients.map((contact) => contact.id);
    const allFilteredRecipientsSelected = filteredRecipientIds.every((id) => selectedRecipients.includes(id));

    if (allFilteredRecipientsSelected) {
      const removableIds = campaignPermissions.canRemoveRecipients
        ? filteredRecipientIds
        : filteredRecipientIds.filter((id) => !currentRecipientIds.includes(id));
      setSelectedRecipients(selectedRecipients.filter((id) => !removableIds.includes(id)));
    } else {
      setSelectedRecipients([...new Set([...selectedRecipients, ...filteredRecipientIds])]);
    }
  };

  const handleOpenForm = () => {
    setEditingCampaign(null);
    setFormError('');
    setActionError('');
    setSuccessMessage('');
    setContactsError('');
    setSelectedRecipients([]);
    setCurrentRecipientIds([]);
    setRecipientSearch('');
    setFormData({ name: '', description: '', channel: 'email', status: 'draft', scheduledAt: '' });
    setIsFormOpen(true);
  };

  const handleEditCampaign = async (campaign) => {
    setEditingCampaign(campaign);
    setFormError('');
    setActionError('');
    setSuccessMessage('');
    setContactsError('');
    setRecipientSearch('');
    setCurrentRecipientIds([]);
    setSelectedRecipients([]);
    setIsLoadingRecipients(true);
    setIsFormOpen(true);
    setFormData({
      name: campaign.name || '',
      description: campaign.description || '',
      channel: campaign.channel,
      status: campaign.status,
      scheduledAt: toDateTimeLocalValue(campaign.scheduledAt),
    });

    try {
      const recipientIds = await listCampaignRecipientIds(campaign.id);
      if (!recipientIds.ok) {
        setFormError(recipientIds.error || 'Could not load current recipients.');
        if (isSignedOut(recipientIds)) setIsSignedOut(true);
        return;
      }

      setCurrentRecipientIds(recipientIds.data);
      setSelectedRecipients(recipientIds.data);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not load current recipients.');
    } finally {
      setIsLoadingRecipients(false);
    }
  };

  const handleDeleteCampaign = async (campaign) => {
    if (!window.confirm(`Delete campaign "${campaign.name}"? This action cannot be undone.`)) return;

    setIsDeletingCampaign(true);
    setActionError('');
    setSuccessMessage('');

    try {
      const result = await deleteCampaign(campaign.id);
      if (!result.ok) {
        setActionError(result.error || 'Could not delete the campaign.');
        if (isSignedOut(result)) setIsSignedOut(true);
        return;
      }

      setSuccessMessage('Campaign deleted successfully.');
      setCampaignRefreshKey((currentKey) => currentKey + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not delete the campaign.');
    } finally {
      setIsDeletingCampaign(false);
    }
  };

  const handleCloseForm = () => {
    if (isLoading) return;
    setIsFormOpen(false);
    setEditingCampaign(null);
  };

  return (
    <DashboardShell title="Campaigns">
      <div className="space-y-6">
        <div className="bg-[#202326] border border-[#2A2C30] rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-[#F3EFE8]">Campaigns</h2>
            <button
              type="button"
              onClick={handleOpenForm}
              disabled={isLoadingCampaigns || isSignedOut || !campaignPermissions.canManage}
              className="flex items-center gap-2 px-4 py-2 bg-[#E8793E] text-white rounded-lg text-sm font-medium hover:bg-[#d66a2f] transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:ring-offset-2 focus:ring-offset-[#202326]"
            >
              <Plus className="w-4 h-4" />
              Create Campaign
            </button>
          </div>
          {!isLoadingCampaigns && !isSignedOut && !campaignPermissions.canManage && (
            <p className="mb-4 text-sm text-[#92979D]">You have read-only access to campaigns.</p>
          )}
          {successMessage && (
            <p role="status" className="mb-4 rounded-lg border border-[#72B89A]/40 bg-[#72B89A]/10 p-3 text-sm text-[#72B89A]">
              {successMessage}
            </p>
          )}
          {actionError && (
            <p role="alert" className="mb-4 rounded-lg border border-red-900/50 bg-red-950/40 p-3 text-sm text-red-300">
              {actionError}
            </p>
          )}
          {loadError && (
            <div role="alert" className="mb-4 rounded-lg border border-red-900/50 bg-red-950/40 p-3 text-sm text-red-300">
              <p>Could not load campaigns: {loadError}</p>
              <button
                type="button"
                onClick={() => setCampaignRefreshKey((currentKey) => currentKey + 1)}
                className="mt-2 font-medium text-[#E8793E] hover:text-[#F3EFE8]"
              >
                Try again
              </button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px]">
              <thead>
                <tr className="border-b border-[#2A2C30]">
                  <th className="text-left py-3 px-4 text-xs font-medium text-[#92979D] uppercase tracking-wider">Name</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[#92979D] uppercase tracking-wider">Channel</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[#92979D] uppercase tracking-wider">Status</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[#92979D] uppercase tracking-wider">Recipients</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[#92979D] uppercase tracking-wider">Scheduled</th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[#92979D] uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoadingCampaigns ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-sm text-[#92979D]">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading campaigns...
                      </span>
                    </td>
                  </tr>
                ) : isSignedOut ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-sm text-[#92979D]">
                      You are signed out. Sign in to view your organization&apos;s campaigns.
                    </td>
                  </tr>
                ) : loadError ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-sm text-red-300">
                      Campaigns could not be displayed.
                    </td>
                  </tr>
                ) : campaigns.map((campaign) => (
                  <tr key={campaign.id} className="border-b border-[#2A2C30] hover:bg-[#2A2C30]/50">
                    <td className="py-3 px-4">
                      <p className="text-sm font-medium text-[#F3EFE8]">{campaign.name}</p>
                      <p className="text-xs text-[#92979D]">{campaign.description}</p>
                    </td>
                    <td className="py-3 px-4 text-sm text-[#92979D] capitalize">{campaign.channel}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full capitalize ${
                        campaign.status === 'completed'
                          ? 'bg-[#72B89A]/10 text-[#72B89A]'
                          : campaign.status === 'sending'
                          ? 'bg-[#E8793E]/10 text-[#E8793E]'
                          : campaign.status === 'failed'
                          ? 'bg-red-500/10 text-red-300'
                          : campaign.status === 'scheduled'
                          ? 'bg-sky-500/10 text-sky-300'
                          : 'bg-[#92979D]/10 text-[#92979D]'
                      }`}>
                        {campaign.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-sm text-[#92979D]">{campaign.recipientCount}</td>
                    <td className="py-3 px-4 text-sm text-[#92979D]">{formatScheduledAt(campaign.scheduledAt)}</td>
                    <td className="py-3 px-4">
                      <div className="flex flex-col items-start gap-2">
                        {campaignPermissions.canManage && (
                          <button
                            type="button"
                            onClick={() => handleEditCampaign(campaign)}
                            disabled={isDeletingCampaign}
                            className="inline-flex items-center gap-1 text-sm font-medium text-[#E8793E] hover:text-[#F3EFE8] disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <Pencil className="h-3 w-3" />
                            Edit
                          </button>
                        )}
                        {campaignPermissions.canDelete && (
                          <button
                            type="button"
                            onClick={() => handleDeleteCampaign(campaign)}
                            disabled={isDeletingCampaign}
                            className="inline-flex items-center gap-1 text-sm font-medium text-red-400 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {isDeletingCampaign ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                            Delete
                          </button>
                        )}
                        {!campaignPermissions.canManage && !campaignPermissions.canDelete && (
                          <span className="text-sm text-[#92979D]">Read only</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!isLoadingCampaigns && !isSignedOut && !loadError && campaigns.length === 0 && (
              <div className="text-center py-8">
                <p className="text-[#92979D]">No campaigns found</p>
              </div>
            )}
          </div>
        </div>
      </div>
      {isFormOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-[#202326] border border-[#2A2C30] rounded-xl max-w-2xl w-full p-6 my-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-[#F3EFE8] mb-4">
              {editingCampaign ? 'Edit Campaign' : 'Create Campaign'}
            </h2>
            <form onSubmit={handleFormSubmit} className="space-y-4">
              {formError && (
                <p role="alert" className="text-sm text-red-300">
                  {formError}
                </p>
              )}
              {isSignedOut && (
                <p role="alert" className="text-sm text-red-300">
                  You are signed out. Sign in before creating a campaign.
                </p>
              )}
              <div>
                <label htmlFor="campaign-name" className="block text-sm font-medium text-[#F3EFE8] mb-1">Campaign Name *</label>
                <input
                  id="campaign-name"
                  type="text"
                  value={formData.name}
                  onChange={(e) => {
                    setFormData({ ...formData, name: e.target.value });
                    setFormError('');
                  }}
                  className="w-full px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] placeholder-[#92979D] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
                  required
                />
              </div>
              <div>
                <label htmlFor="campaign-description" className="block text-sm font-medium text-[#F3EFE8] mb-1">Description</label>
                <textarea
                  id="campaign-description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] placeholder-[#92979D] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
                  rows="3"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="campaign-channel" className="block text-sm font-medium text-[#F3EFE8] mb-1">Channel</label>
                  <select
                    id="campaign-channel"
                    value={formData.channel}
                    onChange={(e) => {
                      setFormData({ ...formData, channel: e.target.value });
                      setFormError('');
                    }}
                    className="w-full px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
                  >
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                    <option value="both">Both</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="campaign-scheduled-at" className="block text-sm font-medium text-[#F3EFE8] mb-1">Schedule Date and Time</label>
                  <input
                    id="campaign-scheduled-at"
                    type="datetime-local"
                    value={formData.scheduledAt}
                    onChange={(e) => setFormData({ ...formData, scheduledAt: e.target.value })}
                    className="w-full px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
                  />
                  <p className="mt-1 text-xs text-[#92979D]">
                    The schedule is recorded with the campaign. No messaging provider is connected yet,
                    so setting a schedule does not send any SMS or email.
                  </p>
                </div>
                <div>
                  <label htmlFor="campaign-status" className="block text-sm font-medium text-[#F3EFE8] mb-1">Status</label>
                  <select
                    id="campaign-status"
                    value={formData.status}
                    onChange={(e) => {
                      setFormData({ ...formData, status: e.target.value });
                      setFormError('');
                    }}
                    className="w-full px-3 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
                  >
                    {campaignStatuses.map((status) => (
                      <option key={status} value={status}>
                        {status.charAt(0).toUpperCase() + status.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label htmlFor="campaign-recipient-search" className="block text-sm font-medium text-[#F3EFE8]">Select Recipients *</label>
                  <p className="text-xs text-[#92979D]">{selectedRecipients.length} selected</p>
                </div>
                <div className="relative mb-3">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-[#92979D]" />
                  <input
                    id="campaign-recipient-search"
                    type="text"
                    placeholder="Search recipients..."
                    value={recipientSearch}
                    onChange={(e) => setRecipientSearch(e.target.value)}
                    className="w-full pl-9 pr-4 py-2 bg-[#151719] border border-[#2A2C30] rounded-lg text-sm text-[#F3EFE8] placeholder-[#92979D] focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:border-transparent"
                  />
                </div>
                <div className="border border-[#2A2C30] rounded-lg max-h-60 overflow-y-auto bg-[#151719]">
                  <div className="p-3 border-b border-[#2A2C30] bg-[#202326]">
                    <label className="flex items-center gap-2 text-sm font-medium text-[#F3EFE8]">
                      <input
                        type="checkbox"
                        checked={filteredRecipients.length > 0 && filteredRecipients.every((contact) => selectedRecipients.includes(contact.id))}
                        disabled={isLoadingContacts || isLoadingRecipients || Boolean(contactsError) || filteredRecipients.length === 0}
                        onChange={handleSelectAllRecipients}
                        className="rounded border-[#2A2C30] bg-[#151719] text-[#E8793E] focus:ring-[#E8793E]"
                      />
                      Select All ({filteredRecipients.length})
                    </label>
                  </div>
                  {isLoadingContacts ? (
                    <div className="p-4 text-center">
                      <span className="inline-flex items-center gap-2 text-sm text-[#92979D]">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading organization contacts...
                      </span>
                    </div>
                  ) : contactsError ? (
                    <div className="p-4 text-center">
                      <p role="alert" className="text-sm text-red-300">Could not load contacts: {contactsError}</p>
                      <button
                        type="button"
                        onClick={() => setContactsRefreshKey((currentKey) => currentKey + 1)}
                        className="mt-2 text-sm font-medium text-[#E8793E] hover:text-[#F3EFE8]"
                      >
                        Try again
                      </button>
                    </div>
                  ) : filteredRecipients.length === 0 && contacts.length === 0 ? (
                    <div className="p-4 text-center">
                      <p className="text-sm text-[#92979D]">No recipients available</p>
                    </div>
                  ) : filteredRecipients.length === 0 ? (
                    <div className="p-4 text-center">
                      <p className="text-sm text-[#92979D]">No recipients found</p>
                    </div>
                  ) : (
                    filteredRecipients.map((contact) => (
                      <div key={contact.id} className="p-3 border-b border-[#2A2C30] last:border-b-0">
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={selectedRecipients.includes(contact.id)}
                            disabled={isLoadingContacts || isLoadingRecipients || (!campaignPermissions.canRemoveRecipients && currentRecipientIds.includes(contact.id))}
                            onChange={() => handleSelectRecipient(contact.id)}
                            className="mt-0.5 rounded border-[#2A2C30] bg-[#151719] text-[#E8793E] focus:ring-[#E8793E]"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-[#F3EFE8]">{contact.firstName} {contact.lastName}</p>
                            <p className="text-xs text-[#92979D]">{contact.email} • {contact.company}</p>
                          </div>
                        </label>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-3 pt-4">
                <button
                  type="submit"
                  disabled={!formData.name.trim() || selectedRecipients.length === 0 || isLoading || isLoadingContacts || isLoadingRecipients || Boolean(contactsError) || isSignedOut || !campaignPermissions.canManage}
                  className="flex-1 px-4 py-2 bg-[#E8793E] text-white rounded-lg text-sm font-medium hover:bg-[#d66a2f] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:ring-offset-2 focus:ring-offset-[#202326]"
                >
                  {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {editingCampaign ? 'Save Changes' : 'Create Campaign'}
                </button>
                <button
                  type="button"
                  onClick={handleCloseForm}
                  disabled={isLoading}
                  className="flex-1 px-4 py-2 bg-transparent border border-[#2A2C30] text-[#F3EFE8] rounded-lg text-sm font-medium hover:bg-[#2A2C30] transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#E8793E] focus:ring-offset-2 focus:ring-offset-[#202326]"
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
