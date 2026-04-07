import { createRouter, createWebHashHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const router = createRouter({
  history: createWebHashHistory("/webui/"),
  routes: [
    {
      path: "/login",
      name: "login",
      component: () => import("@/pages/LoginPage.vue"),
      meta: { public: true }
    },
    {
      path: "/",
      redirect: "/sessions"
    },
    {
      path: "/sessions",
      name: "sessions",
      component: () => import("@/pages/SessionsPage.vue")
    },
    {
      path: "/config",
      name: "config",
      component: () => import("@/pages/ConfigPage.vue")
    },
    {
      path: "/data",
      name: "data",
      component: () => import("@/pages/DataPage.vue")
    },
    {
      path: "/workspace",
      name: "workspace",
      component: () => import("@/pages/WorkspacePage.vue")
    },
    {
      path: "/settings",
      name: "settings",
      component: () => import("@/pages/SettingsPage.vue")
    },
    {
      path: "/:pathMatch(.*)*",
      redirect: "/sessions"
    }
  ]
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  if (to.meta.public) {
    // Already authenticated → skip login page
    if (auth.authenticated) {
      return { name: "sessions" };
    }
    return true;
  }

  // Protected route: ensure auth status is checked
  if (!auth.checked) {
    await auth.check();
  }

  if (!auth.authenticated) {
    return { name: "login", query: { redirect: to.fullPath } };
  }

  return true;
});

export default router;
