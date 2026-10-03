// Single source of truth for assignable admin permissions. Superadmin implicitly has all of them.
// Team management, roles and the audit log are superadmin-only and are deliberately not listed here.
const MODULES = [
    { key: "dashboard", label: "Dashboard", actions: [
        { key: "view", label: "View dashboard" },
        { key: "financials", label: "See revenue figures and charts on dashboard" }
    ] },
    { key: "users", label: "Users", actions: [
        { key: "view", label: "View users" },
        { key: "edit", label: "Edit users" },
        { key: "delete", label: "Delete users" },
        { key: "wallet", label: "Adjust user wallet balance" }
    ] },
    { key: "astrologers", label: "Astrologers", actions: [
        { key: "view", label: "View astrologers (full details)" },
        { key: "approve", label: "Approve / reject astrologers" },
        { key: "edit", label: "Edit astrologers" },
        { key: "delete", label: "Delete astrologers" }
    ] },
    { key: "kyc", label: "KYC Verification", actions: [{ key: "view", label: "View KYC" }] },
    { key: "interviews", label: "Interviews", actions: [
        { key: "view", label: "View interviews" },
        { key: "manage", label: "Schedule / pass / fail interviews" }
    ] },
    { key: "bookings", label: "Appointments & Video sessions", actions: [
        { key: "view", label: "View appointments" },
        { key: "manage", label: "Create / edit / delete appointments" }
    ] },
    { key: "chats", label: "Chats", actions: [{ key: "view", label: "View chats" }] },
    { key: "calls", label: "Calls", actions: [{ key: "view", label: "View calls" }] },
    { key: "payments", label: "Payments & Transactions", actions: [
        { key: "view", label: "View payments / transactions" },
        { key: "manage", label: "Edit / delete payments" }
    ] },
    { key: "finance", label: "Platform earnings", actions: [{ key: "view", label: "See total platform profit and earnings" }] },
    { key: "withdrawals", label: "Withdraw requests", actions: [
        { key: "view", label: "View withdraw requests" },
        { key: "manage", label: "Approve / reject withdrawals" }
    ] },
    { key: "reports", label: "Reports", actions: [{ key: "view", label: "View reports" }] },
    { key: "reviews", label: "Reviews", actions: [{ key: "view", label: "View reviews" }] },
    { key: "notifications", label: "Notifications", actions: [{ key: "view", label: "View notifications" }] },
    { key: "promotions", label: "Offers & Bonus", actions: [
        { key: "view", label: "View offers, coupons and bonus history" },
        { key: "manage", label: "Create / edit offers, coupons and give bonus" }
    ] },
    { key: "promopayouts", label: "Promo payouts", actions: [
        { key: "view", label: "View free-session time owed to astrologers" },
        { key: "manage", label: "Mark promo payouts as paid / change the rate" }
    ] },
    { key: "banners", label: "Banner management", actions: [
        { key: "view", label: "View app banners" },
        { key: "manage", label: "Add / edit / remove app banners and upload images" }
    ] },
    { key: "store", label: "Astro Store", actions: [
        { key: "view", label: "View store products" },
        { key: "manage", label: "Add / edit / remove products, set price and images" }
    ] },
    { key: "support", label: "Customer complaints", actions: [
        { key: "view", label: "View complaints raised about transactions" },
        { key: "manage", label: "Reply to, assign, resolve or reject complaints" }
    ] },
    { key: "addmoney", label: "Add Money settings", actions: [
        { key: "view", label: "View Add Money settings" },
        { key: "manage", label: "Change quick amounts, extra bonus and limits" }
    ] },
    { key: "planets", label: "Planetary Insights", actions: [
        { key: "view", label: "View planetary insights" },
        { key: "manage", label: "Add / edit / remove planetary insights and images" }
    ] }
];

const ALL_PERMISSIONS = MODULES.flatMap((m) => m.actions.map((a) => `${m.key}.${a.key}`));

const isValidPermission = (p) => ALL_PERMISSIONS.includes(p);
const sanitizePermissions = (list) =>
    [...new Set((Array.isArray(list) ? list : []).filter(isValidPermission))];

module.exports = { MODULES, ALL_PERMISSIONS, isValidPermission, sanitizePermissions };
