import type { Rule, UrgencyFloor } from './types.ts';

export const RULEPACK_VERSION = 'rulepack@1';

/**
 * Every rule below keys on a sender observed in the real mailbox on 2026-08-24.
 * None of it is guessed. Where a domain was assumed during planning and turned
 * out wrong, the note records it, because the correction is the lesson.
 *
 * Priority bands:
 *   100  identity/security — must never be misfiled or sent to a model
 *    90  bounces and open loops — the Follow-Up Desk's deterministic seeds
 *    80  money, transactional
 *    70  money, promotional (must outrank generic sender-family rules)
 *    60  investment, dev, orders
 *    40  career and bulk promo
 */
export const SEED_RULES: Rule[] = [
  // ---------------------------------------------------------------- security
  {
    id: 'sec.otp',
    note: 'OTP and recovery codes terminate at Tier 0 and never reach an LLM API.',
    priority: 100,
    when: {
      fromPattern: /^(security@mail\.instagram\.com|aadhaar@uidai\.gov\.in|account@godaddy\.com)$/i,
    },
    then: { category: 'security', urgency: 'none', action: 'archive', archiveEligible: true, resolves: true },
  },
  {
    id: 'sec.google-account',
    priority: 100,
    when: { fromExact: ['noreply-accounts@google.com', 'no-reply@accounts.google.com'] },
    then: { category: 'security', urgency: 'none', action: 'archive', archiveEligible: true, resolves: true },
  },
  {
    id: 'sec.anthropic',
    priority: 100,
    when: { fromDomainSuffix: ['mail.anthropic.com'], subject: /security alert/i },
    then: { category: 'security', urgency: 'someday', action: 'archive', resolves: true },
  },
  {
    id: 'sec.github-token',
    priority: 100,
    when: { fromExact: ['noreply@github.com'], subject: /token|password|security|two-factor/i },
    then: { category: 'security', urgency: 'someday', action: 'archive', resolves: true },
  },

  // ----------------------------------------------------------------- bounces
  {
    id: 'loop.bounce',
    note: 'Five of these went unnoticed while he kept mailing a dead address.',
    priority: 95,
    when: {
      fromPattern: /^(mailer-daemon|postmaster)@/i,
    },
    then: { category: 'bounce', urgency: 'today', action: 'decide', resolves: true },
  },

  // ------------------------------------------------------------- open loops
  {
    id: 'loop.sent-to-support',
    note: 'Outbound to a support desk opens a tracked loop, no model required.',
    priority: 90,
    when: {
      outbound: true,
      toPattern: /^(support|care|help|helpdesk|customercare|nodalofficer|grievance)[@+]|@.*zendesk\.com$/i,
    },
    then: { category: 'support', urgency: 'none', action: 'wait', opensLoop: true, resolves: true },
  },
  {
    id: 'loop.sent-followup-phrasing',
    note: 'He writes "Polite follow-up on ticket #…" himself. Catch his own system.',
    priority: 90,
    when: { outbound: true, text: /follow[\s.-]?up|gentle reminder|escalat|writing to (?:kindly )?(?:follow|remind)/i },
    then: { category: 'support', urgency: 'none', action: 'wait', opensLoop: true, resolves: true },
  },
  {
    id: 'loop.inbound-support-sender',
    note:
      'Weakest evidence in the pack, so it sits below every named sender. ' +
      '"support@" is a shape, not a meaning: SaveSage bills arrive from ' +
      'support@savesage.club and 1mg markets from care@ — both outranked this ' +
      'rule on the first run and were misfiled as support threads.',
    priority: 20,
    when: {
      outbound: false,
      fromPattern: /^(support|care|help|helpdesk|customercare|nodalofficer|grievance)[@+.\-]|[.\-]support@|@.*zendesk\.com$|^.*-support@/i,
    },
    then: { category: 'support', urgency: 'this_week', action: 'reply', opensLoop: true, resolves: true },
  },
  {
    id: 'loop.inbound-ticket',
    note:
      'Requires a support word next to the number. A bare "#1993" is an order ' +
      'shipment, not an open loop — that precedence bug misfiled a Shopify mail. ' +
      'Still ranks below named senders, which know better.',
    priority: 30,
    when: {
      outbound: false,
      text: /\b(?:ticket|your request|case|complaint|request)\b[\s#:.\-]*\(?\s?\d{3,}/i,
    },
    then: { category: 'support', urgency: 'this_week', action: 'reply', opensLoop: true, resolves: true },
  },

  // ------------------------------------------------------ money transactional
  {
    id: 'money.savesage',
    note: 'One parser covers all four cards. The single highest-yield rule here.',
    priority: 85,
    when: { fromDomain: ['savesage.club'] },
    then: { category: 'bill', urgency: 'this_week', action: 'pay', parser: 'savesage', resolves: true },
  },
  {
    id: 'money.hdfc-statement',
    note: 'hdfcbank.bank.in — NOT hdfcbank.net, which is what the plan assumed.',
    priority: 85,
    when: { fromExact: ['emailstatements.cards@hdfcbank.bank.in'] },
    then: { category: 'bill', urgency: 'this_week', action: 'pay', parser: 'hdfcStatement', resolves: true },
  },
  {
    id: 'money.hdfc-alert',
    note: 'Same domain as the statement, different local part. UPI-on-credit-card.',
    priority: 85,
    when: { fromExact: ['alerts@hdfcbank.bank.in'] },
    then: { category: 'transaction', urgency: 'none', action: 'archive', parser: 'hdfcAlert', archiveEligible: true, resolves: true },
  },
  {
    id: 'money.razorpay',
    priority: 85,
    when: { fromDomain: ['razorpay.com'], subject: /payment successful|payment received/i },
    then: { category: 'transaction', urgency: 'none', action: 'archive', parser: 'razorpay', archiveEligible: true, resolves: true },
  },
  {
    id: 'money.issuer-fallback',
    note: 'Amount+due-date only. The canary for a SaveSage outage.',
    priority: 82,
    when: {
      fromDomainSuffix: ['icicibank.com', 'axisbank.com', 'sbicard.com', 'kotak.com'],
      subject: /statement|bill|due|payment/i,
    },
    then: { category: 'bill', urgency: 'this_week', action: 'pay', resolves: true },
  },
  {
    id: 'money.phonepe',
    priority: 80,
    when: { fromDomain: ['phonepe.com'] },
    then: { category: 'transaction', urgency: 'none', action: 'archive', archiveEligible: true, resolves: true },
  },

  // -------------------------------------------------------- money promotional
  {
    id: 'promo.hdfc-mailers',
    note: 'Same brand as the alerts, opposite meaning. ~15 loan pushes per 10 days.',
    priority: 75,
    when: { fromDomain: ['mailers.hdfcbank.bank.in'] },
    then: { category: 'promo', urgency: 'none', action: 'archive', archiveEligible: true, resolves: true },
  },
  {
    id: 'promo.loyalty',
    priority: 72,
    when: {
      fromDomainSuffix: [
        'flyai.airindia.com',
        'email-marriott.com',
        'mail.all.com',
        'indigobluchipalerts.goindigo.in',
        'noreply.maximize.money',
      ],
    },
    then: { category: 'promo', urgency: 'none', action: 'archive', archiveEligible: true, resolves: true },
  },
  {
    id: 'promo.retail-finance',
    priority: 72,
    when: {
      fromDomainSuffix: ['rmp.flipkart.com', 'idbibank.com', 'e.godaddy.com', 'fashionnotification.tatacliq.com'],
    },
    then: { category: 'promo', urgency: 'none', action: 'archive', archiveEligible: true, resolves: true },
  },

  // -------------------------------------------------------------- renewals
  {
    id: 'renewal.vendor-receipt',
    note: 'Seeds the renewal ledger. Suspension language is escalated by a floor.',
    priority: 70,
    when: {
      fromDomainSuffix: ['godaddy.com', 'email.apple.com', 'vercel.com', 'amazonaws.com', 'google.com'],
      // `suspen` not `suspend`: the live AWS mail says "suspension", which the
      // stricter stem silently failed to match on the first run.
      subject: /subscription|renew|invoice|receipt|order|expired?|suspen|payment|billing/i,
    },
    then: { category: 'renewal', urgency: 'this_week', action: 'decide', resolves: true },
  },

  // ------------------------------------------------------------- investment
  {
    id: 'invest.evoting',
    note: 'Hard voting windows are genuine dated obligations.',
    priority: 68,
    when: { fromDomainSuffix: ['cdslindia.co.in', 'nsdl.com'], subject: /e-?voting|ballot|meeting/i },
    then: { category: 'investment', urgency: 'this_week', action: 'decide', resolves: true },
  },
  {
    id: 'invest.statements',
    note: 'Weekly PDFs; the password is his PAN, so they are parsed locally only.',
    priority: 66,
    when: {
      fromExact: ['noreply@groww.in', 'noreply@share.market', 'noreply@unibrokers.in'],
    },
    then: { category: 'investment', urgency: 'none', action: 'archive', archiveEligible: true, resolves: true },
  },
  {
    id: 'promo.market-digests',
    priority: 65,
    when: {
      fromDomainSuffix: [
        'digest.groww.in',
        'updates.share.market',
        'mailer.moneycontrol.com',
        'economictimesnews.com',
        'substack.com',
      ],
    },
    then: { category: 'promo', urgency: 'none', action: 'archive', archiveEligible: true, resolves: true },
  },

  // -------------------------------------------------------------------- dev
  {
    id: 'dev.github',
    note: 'Identical workflow failures collapse into one streak row downstream.',
    priority: 64,
    when: { fromExact: ['notifications@github.com'] },
    then: { category: 'dev', urgency: 'someday', action: 'convert_task', resolves: true },
  },

  // ----------------------------------------------------------------- orders
  {
    id: 'txn.order-receipts',
    priority: 60,
    when: {
      fromDomainSuffix: [
        'eatsure.com',
        't.shopifyemail.com',
        'updates.neurogumindia.com',
        'wearcomet.com',
        'urbancompany.com',
        'dailyobjects.com',
        'maximize.money',
      ],
    },
    then: { category: 'transaction', urgency: 'none', action: 'archive', archiveEligible: true, resolves: true },
  },
  {
    id: 'txn.amazon',
    priority: 60,
    when: { fromDomainSuffix: ['amazon.in'] },
    then: { category: 'transaction', urgency: 'none', action: 'archive', archiveEligible: true, resolves: true },
  },

  // --------------------------------------------------------------- academic
  {
    id: 'academic.college',
    note: 'One real mail in 365 days, delivered by BCC. Rare, precious, never archived.',
    priority: 92,
    when: { fromDomainSuffix: ['sxcpatna.edu.in'] },
    then: { category: 'personal', urgency: 'this_week', action: 'reply', resolves: true },
  },

  // ----------------------------------------------------------------- career
  {
    id: 'career.boards',
    priority: 40,
    when: {
      fromDomainSuffix: [
        'naukri.com',
        'internshala.com',
        'updates.internshala.com',
        'linkedin.com',
        'jobalertshub.com',
      ],
    },
    then: { category: 'career', urgency: 'none', action: 'archive', archiveEligible: true, resolves: true },
  },

  // ------------------------------------------------------------- bulk promo
  {
    id: 'promo.edu-marketing',
    priority: 40,
    when: {
      fromDomainSuffix: [
        'nism.ac.in',
        'vanillaforums.email',
        'simandhareducation.com',
        'lablab.ai',
        'noreply.hack2skill.com',
        'extern.com',
        'corporatefinanceinstitute.com',
        'onepercentclub.io',
        'update.ketto.org',
      ],
    },
    then: { category: 'promo', urgency: 'none', action: 'archive', archiveEligible: true, resolves: true },
  },
  {
    id: 'promo.consumer-brands',
    priority: 40,
    when: {
      fromDomainSuffix: [
        'm.nothing.tech',
        'insideapple.apple.com',
        'mailer.jio.com',
        'emaila.1mg.com',
        'e.zoom.us',
        'steampowered.com',
        'playstation.com',
      ],
    },
    then: { category: 'promo', urgency: 'none', action: 'archive', archiveEligible: true, resolves: true },
  },
  {
    id: 'promo.unsubscribable',
    note: 'Last-resort bulk detector. Labels but does not resolve — Tier 1 confirms.',
    priority: 10,
    when: { text: /\bunsubscribe\b|no longer want to receive|opt-?out\b/i, outbound: false },
    then: { category: 'promo', urgency: 'none', action: 'archive', resolves: false },
  },
];

/**
 * Floors escalate urgency and nothing else. They fire on top of whatever the
 * category rule decided, and no model may lower the result.
 */
export const URGENCY_FLOORS: UrgencyFloor[] = [
  {
    id: 'floor.payment-health',
    note: 'AWS and X both sat unread with exactly this language.',
    when: {
      outbound: false,
      text: /\b(?:imminent suspension|suspension notice|will be suspended|account (?:has been )?suspended|subscription suspended|payment (?:has )?failed|payment issue|act now to prevent|past due|overdue)\b/i,
    },
    floor: 'today',
    action: 'decide',
  },
  {
    id: 'floor.due-language',
    when: {
      outbound: false,
      text: /\b(?:due date|payment due|last date|due by|closes on|expires on)\b/i,
    },
    floor: 'this_week',
  },
  {
    id: 'floor.college',
    when: { outbound: false, fromDomainSuffix: ['sxcpatna.edu.in'] },
    floor: 'this_week',
  },
  {
    id: 'floor.bounce',
    when: { outbound: false, fromPattern: /^(mailer-daemon|postmaster)@/i },
    floor: 'today',
    action: 'decide',
  },
];
