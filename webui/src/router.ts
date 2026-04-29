import { defineComponent } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const WorkbenchRouteView = defineComponent({
  name: "WorkbenchRouteView",
  setup: () => () => null
});

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
      component: () => import("@/sections/AppWorkbenchRoot.vue"),
      children: [
        {
          path: "",
          redirect: { name: "sessions" }
        },
        {
          path: "sessions",
          name: "sessions",
          component: WorkbenchRouteView,
          meta: { workbenchViewId: "sessions" }
        },
        {
          path: "config",
          name: "config",
          component: WorkbenchRouteView,
          meta: { workbenchViewId: "config" }
        },
        {
          path: "data",
          name: "data",
          component: WorkbenchRouteView,
          meta: { workbenchViewId: "data" }
        },
        {
          path: "files",
          name: "files",
          component: WorkbenchRouteView,
          meta: { workbenchViewId: "files" }
        },
        {
          path: "settings",
          name: "settings",
          component: WorkbenchRouteView,
          meta: { workbenchViewId: "settings" }
        }
      ]
    },
    {
      path: "/:pathMatch(.*)*",
      redirect: { name: "sessions" }
    }
  ]
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  if (to.meta.public) {
    if (!auth.checked) {
      await auth.check();
    }

    if (!auth.enabled) {
      return { name: "sessions" };
    }

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

  if (!auth.enabled) {
    return true;
  }

  if (!auth.authenticated) {
    return { name: "login", query: { redirect: to.fullPath } };
  }

  return true;
});

export default router;
