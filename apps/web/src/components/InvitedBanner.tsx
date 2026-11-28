import { Button, Icon } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";

/**
 * An email invitation to another workspace that still waits for this account (`me.invitations`), in the outage
 * notices' style: someone who made a workspace of their own on the way in can still join the one that invited them.
 */
export function InvitedBanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { me } = useOrg();
  const invitation = me.invitations?.[0];
  if (!invitation) return null;
  const org = invitation.orgName;
  const title = t("invite.invitedYouNoName", { org });
  return (
    <section className="outages" aria-label={title}>
      <div className="outage hold-banner" role="status">
        <Icon name="mail" size={20} className="outage__icon" />
        <span className="outage__text">
          <b>{title}</b>
        </span>
        <span className="outage__acts">
          <Button
            size="sm"
            variant="primary"
            onClick={() => void navigate({ to: "/invite/$token", params: { token: invitation.token } })}
          >
            {t("invite.enter", { org })}
          </Button>
        </span>
      </div>
    </section>
  );
}
