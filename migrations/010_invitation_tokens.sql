ALTER TABLE organization_invitations ADD COLUMN token_hash CHAR(64) NULL;
ALTER TABLE organization_invitations ADD COLUMN expires_at DATETIME(3) NULL;
ALTER TABLE organization_invitations ADD COLUMN accepted_at DATETIME(3) NULL;
ALTER TABLE organization_invitations ADD UNIQUE KEY organization_invitations_token_unique (token_hash);
