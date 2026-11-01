interface ProductInformationProps {
  name: string;
  slug: string;
  description: string;
  onNameChange: (value: string) => void;
  onSlugChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
}

export function ProductInformationSection({ name, slug, description, onNameChange, onSlugChange, onDescriptionChange }: ProductInformationProps) {
  return (
    <div className="form-section">
      <div className="form-section-heading"><span>01</span><div><h2>产品信息</h2><p>用于在产品总览和浏览器地址中展示。</p></div></div>
      <div className="form-grid">
        <label className="field"><span>产品名称 <b>*</b></span><input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="例如 SalesBuddy" maxLength={100} required autoFocus /></label>
        <label className="field"><span>产品 Slug <b>*</b></span><input value={slug} onChange={(event) => onSlugChange(event.target.value)} placeholder="salesbuddy" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required /><small>小写字母、数字和连字符；中文名产品可填 tingfeng。</small></label>
      </div>
      <label className="field"><span>产品简介</span><textarea value={description} onChange={(event) => onDescriptionChange(event.target.value)} placeholder="一句话说明这个产品解决什么问题" rows={3} maxLength={1000} /></label>
    </div>
  );
}

interface RepositorySectionProps {
  repository: string;
  defaultBranch: string;
  onRepositoryChange: (value: string) => void;
  onBranchChange: (value: string) => void;
}

export function RepositorySection({ repository, defaultBranch, onRepositoryChange, onBranchChange }: RepositorySectionProps) {
  return (
    <div className="form-section">
      <div className="form-section-heading"><span>02</span><div><h2>GitHub 仓库</h2><p>Radar 会验证当前 GitHub Token 是否有读取权限。</p></div></div>
      <div className="form-grid">
        <label className="field"><span>仓库 <b>*</b></span><input value={repository} onChange={(event) => onRepositoryChange(event.target.value)} placeholder="gzhanlei/salesbuddy" required /><small>使用 owner/repo 格式，当前先接入一个主仓库。</small></label>
        <label className="field"><span>默认分支</span><input value={defaultBranch} onChange={(event) => onBranchChange(event.target.value)} placeholder="留空则读取仓库默认分支" /><small>只有这个分支的 push 会触发自动分析。</small></label>
      </div>
    </div>
  );
}
