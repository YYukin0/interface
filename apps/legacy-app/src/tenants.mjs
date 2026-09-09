/**
 * Two institutions running the same vendor product.
 *
 * This is the cross-tenant reuse demo (D11) made concrete. The differences are
 * chosen to be exactly the kinds a branding pack and a point release produce in
 * real core-banking deployments, and each one breaks a *different* locator
 * strategy — which is the whole reason the artifact stores an ordered bundle
 * rather than one selector:
 *
 *   navLabel      breaks `role-name` and any text strategy   → tenant override
 *   showFees      breaks positional XPath (`td[3]` → `td[4]`) → tenant override
 *   skin          breaks nothing                              → no override
 *
 * `role-name` on the search field and button is untouched in both, so the
 * baseline steps that use it need no override at all. A tenant patch that had
 * to restate every step would tell us nothing about which locators survive.
 */

/**
 * @typedef {object} Tenant
 * @property {string} id
 * @property {string} basePath      URL prefix, e.g. '' or '/tenant-b'.
 * @property {string} institution
 * @property {string} navLabel      Text of the member-search nav link.
 * @property {boolean} showFees     Inserts a Fees column into the summary table.
 * @property {string} headerBg
 * @property {string} accent
 */

/** @type {Record<string, Tenant>} */
export const TENANTS = {
  'tenant-a': {
    id: 'tenant-a',
    basePath: '',
    institution: 'Northgate Federal Credit Union',
    navLabel: 'Member Search',
    showFees: false,
    headerBg: '#000080',
    accent: '#c0c0c0',
  },
  'tenant-b': {
    id: 'tenant-b',
    basePath: '/tenant-b',
    institution: 'Riverside Community CU',
    navLabel: 'Find Member',
    showFees: true,
    headerBg: '#004000',
    accent: '#d8d8b0',
  },
};

export const DEFAULT_TENANT = 'tenant-a';

/** @param {string | undefined} id @returns {Tenant} */
export function tenantOf(id) {
  return TENANTS[id ?? DEFAULT_TENANT] ?? TENANTS[DEFAULT_TENANT];
}
