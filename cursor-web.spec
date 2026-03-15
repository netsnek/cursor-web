%global cursor_version %{?cursor_version}%{!?cursor_version:0.0.0}

Name:           cursor-web
Version:        %{cursor_version}
Release:        1%{?dist}
Summary:        Cursor IDE served as a web application
License:        MIT
URL:            https://github.com/netsnek/cursor-web

BuildRequires:  nodejs >= 20
BuildRequires:  python3
Requires:       nodejs >= 20

%description
Cursor Web — VS Code Web built from source with Cursor's desktop workbench overlay.
Provides the full Cursor IDE experience in a browser via a single Node.js process.

%install
install -d %{buildroot}/opt/cursor-web
cp -a %{_builddir}/../dist/* %{buildroot}/opt/cursor-web/

install -d %{buildroot}/usr/lib/systemd/system
cat > %{buildroot}/usr/lib/systemd/system/cursor-web.service << 'EOF'
[Unit]
Description=Cursor Web IDE Server
After=network.target

[Service]
Type=simple
User=cursor-web
ExecStart=/usr/bin/node /opt/cursor-web/out/server-main.js --host 0.0.0.0 --port 20000 --without-connection-token
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

install -d %{buildroot}/usr/bin
cat > %{buildroot}/usr/bin/cursor-web << 'LAUNCHER'
#!/bin/bash
exec node /opt/cursor-web/out/server-main.js "$@"
LAUNCHER
chmod +x %{buildroot}/usr/bin/cursor-web

%pre
getent passwd cursor-web >/dev/null || useradd -r -m -s /sbin/nologin cursor-web

%files
/opt/cursor-web
/usr/lib/systemd/system/cursor-web.service
/usr/bin/cursor-web

%changelog
