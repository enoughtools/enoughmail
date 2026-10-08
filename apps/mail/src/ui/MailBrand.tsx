import mark from '../../../../branding/assets/marks/mark-ink.svg';

/** Shared Enough mark with a subordinate product descriptor. */
export default function MailBrand() {
  return <span className="mail-wordmark" aria-label="Enough Mail">
    <img src={mark} alt="" width="28" height="28" />
    <span><strong>enough</strong><span className="mail-brand-descriptor">mail</span></span>
  </span>;
}
