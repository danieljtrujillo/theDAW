/**
 * CatalogueProviderBadge — merged into `components/library/ProviderBadge`.
 *
 * There were two provider badges: this one, which DERIVED a platform from
 * `model` + `source` and always rendered, and `ProviderBadge`, which drew the
 * provider the backend DETECTED in the file's metadata. Every render site had
 * to pick one with a conditional. There is one provider per entry now
 * (`inferProvider`), so there is one badge, and it is `ProviderBadge`: it
 * takes the whole entry (`entry={…}`) rather than loose `provider` / `model` /
 * `source` props.
 *
 * This alias is kept so the name still resolves; nothing in the app imports
 * it. Import `ProviderBadge` directly in new code.
 */
export { ProviderBadge as CatalogueProviderBadge } from '../components/library/ProviderBadge';
