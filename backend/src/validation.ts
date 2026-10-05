import { DOMParser } from '@xmldom/xmldom';
import xpath from 'xpath';
import type { Profile } from '@node-saml/node-saml';
export type User = { nameId: string; tenantId: string | null; objectId: string | null; name: string | null; email: string | null };
const ns = xpath.useNamespaces({ p: 'urn:oasis:names:tc:SAML:2.0:protocol', a: 'urn:oasis:names:tc:SAML:2.0:assertion' });

// Call only AFTER Node-SAML has verified both signatures and assertion constraints.
export function validateEnvelope(xml: string, callbackUrl: string, idpIssuer: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD is forbidden');
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Node;
  const nodes = (path: string) => ns(path, doc) as Node[];
  const text = (path: string) => String(ns(`string(${path})`, doc));
  if (nodes('/p:Response').length !== 1 || nodes('/p:Response/a:Assertion').length !== 1) throw new Error('Expected one response and assertion');
  if (text('/p:Response/@Destination') !== callbackUrl) throw new Error('Invalid Destination');
  for (const path of ['/p:Response/a:Issuer', '/p:Response/a:Assertion/a:Issuer']) {
    if (nodes(path).length !== 1 || text(path) !== idpIssuer) throw new Error('Invalid Issuer');
  }
  const subject = '/p:Response/a:Assertion/a:Subject/a:SubjectConfirmation';
  if (nodes(subject).length !== 1 || text(`${subject}/@Method`) !== 'urn:oasis:names:tc:SAML:2.0:cm:bearer') throw new Error('Invalid SubjectConfirmation');
  if (nodes(`${subject}/a:SubjectConfirmationData`).length !== 1 || text(`${subject}/a:SubjectConfirmationData/@Recipient`) !== callbackUrl) throw new Error('Invalid Recipient');
  const responseId = text('/p:Response/@InResponseTo');
  if (!responseId || text(`${subject}/a:SubjectConfirmationData/@InResponseTo`) !== responseId) throw new Error('Invalid InResponseTo');
  for (const path of ['/p:Response/a:Assertion/a:Conditions/@NotOnOrAfter', `${subject}/a:SubjectConfirmationData/@NotOnOrAfter`]) {
    const expiry = Date.parse(text(path));
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Missing or expired validity');
  }
}
export function userFromProfile(profile: Profile): User {
  const claim = (...keys: string[]) => {
    for (const key of keys) {
      const raw = profile[key];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
  };
  if (!profile.nameID) throw new Error('NameID is required');
  return { nameId: profile.nameID,
    tenantId: claim('http://schemas.microsoft.com/identity/claims/tenantid'),
    objectId: claim('http://schemas.microsoft.com/identity/claims/objectidentifier'),
    name: claim('http://schemas.microsoft.com/identity/claims/displayname', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', 'displayName'),
    email: claim('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'email') };
}
