| ID | Package | Installed | Fixed | Severity | Target |
|---|---|---|---|---|---|
{{- range . }}
{{- $target := .Target }}
{{- range .Vulnerabilities }}
| {{ .VulnerabilityID }} | {{ .PkgName }} | {{ .InstalledVersion }} | {{ .FixedVersion }} | {{ .Severity }} | {{ $target }} |
{{- end }}
{{- end }}