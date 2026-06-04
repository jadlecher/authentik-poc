/**
 * UserProfile — displays identity from the ID token (client-side only).
 *
 * The id_token claims are available via auth.user.profile without any server
 * round-trip. We display email, name, and groups from the ID token claims.
 *
 * Tokens are NOT logged. We only render safe string values from the profile.
 */
import { useAuth } from 'react-oidc-context'

export function UserProfile() {
  const auth = useAuth()
  const profile = auth.user?.profile

  if (!profile) return null

  // Groups claim — authentik includes it in the ID token when scope includes "groups"
  const groups = Array.isArray(profile['groups']) ? (profile['groups'] as string[]) : []
  const isAdmin = groups.includes('admins')

  return (
    <div className="card">
      <h2>Identity (from ID token)</h2>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          <tr>
            <td style={{ width: 160, fontWeight: 'bold', paddingBottom: '0.4rem' }}>Email</td>
            <td>{profile.email ?? '—'}</td>
          </tr>
          <tr>
            <td style={{ fontWeight: 'bold', paddingBottom: '0.4rem' }}>Name</td>
            <td>{profile.name ?? '—'}</td>
          </tr>
          <tr>
            <td style={{ fontWeight: 'bold', paddingBottom: '0.4rem' }}>Sub</td>
            <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{profile.sub}</td>
          </tr>
          <tr>
            <td style={{ fontWeight: 'bold', paddingBottom: '0.4rem' }}>Groups</td>
            <td>
              {groups.length === 0 ? '—' : groups.map(g => (
                <span key={g} className={`tag${g === 'admins' ? ' admin' : ''}`}>{g}</span>
              ))}
            </td>
          </tr>
          <tr>
            <td style={{ fontWeight: 'bold' }}>Role</td>
            <td>
              <span className={`tag${isAdmin ? ' admin' : ''}`}>
                {isAdmin ? 'admin' : 'user'}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
